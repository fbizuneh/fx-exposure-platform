// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// data_source schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountId, asOfDate, entityId, programId, tenantId, type AsOfDate, type TenantId } from "@shared/kernel";
import type { Account, Entity, MasterDataQuestions } from "@services/master-data/contract";
import { migrate } from "../../../scripts/migrate.mjs";
import { BatchRefused, connect, createDataSource, RuleInvalid, type Db, type GlBalanceRow } from "./index.ts";
import { q } from "./db.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("data source database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

// A small master data, in memory. Chart C: node 1 > 11 > 111; accounts 1000 on 111, 1100 on 11, 2000 on node 2, 9000 on none.
const NODES: Record<string, string | null> = { "1": null, "11": "1", "111": "11", "2": null };
const ACCOUNTS: Record<string, string | null> = { "1000": "111", "1100": "11", "2000": "2", "9000": null };
const ENTITY_CODES = ["US1", "DE1"];
const account = (n: string): Account => ({
  accountId: accountId(`acct-${n}`), chartCode: "C", accountNumber: n, name: n, statementType: "BALANCE_SHEET", normalBalance: "DEBIT",
  monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode: ACCOUNTS[n]!,
});
const entity = (code: string): Entity => ({
  entityId: entityId(`ent-${code}`), code, name: code, type: "LEGAL_ENTITY", parentEntityId: null, countryCode: "US", functionalCurrency: "USD",
  isLegalEntity: true, isTreasuryEntity: false, isHedgeExecutionEntity: false,
});
const pathOf = (code: string): string[] => (code in NODES ? [code, ...(NODES[code] ? pathOf(NODES[code]!) : [])] : []);
const md: MasterDataQuestions = {
  async getEntity(_t, code) { return ENTITY_CODES.includes(code) ? entity(code) : null; },
  async getAccount(_t, chart, n) { return chart === "C" && n in ACCOUNTS ? account(n) : null; },
  async getEntities(_t, codes) { return codes.filter((c) => ENTITY_CODES.includes(c)).map(entity); },
  async getAccounts(_t, keys) { return keys.filter((k) => k.chartCode === "C" && k.accountNumber in ACCOUNTS).map((k) => account(k.accountNumber)); },
  async hierarchyPaths(_t, chart, nodes) { return chart === "C" ? nodes.filter((n) => n in NODES).map((n) => ({ nodeCode: n, path: pathOf(n) })) : []; },
  async accountsUnderNode(_t, chart, node) {
    return chart === "C" ? Object.keys(ACCOUNTS).filter((n) => ACCOUNTS[n] !== null && pathOf(ACCOUNTS[n]!).includes(node)).map(account) : [];
  },
  async entityWalk() { return []; },
  async functionalCurrencies() { return []; },
  async getCurrencies() { return []; },
  async getCalendars() { return []; },
};

let db: Db;
let ds: ReturnType<typeof createDataSource>;
const clock = new Date("2026-03-10T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("data_source").ifExists().cascade().execute();
  await migrate(url!);
  ds = createDataSource(db, { masterData: md, now: () => clock });
});
after(async () => {
  if (enabled) await db.destroy();
});

const D1 = asOfDate("2026-03-05");
const D2 = asOfDate("2026-03-06");
const newTenant = () => tenantId(randomUUID());
const bal = (accountNumber: string, balance: string, over: Partial<GlBalanceRow> = {}): GlBalanceRow => ({
  entityCode: "US1", accountNumber, currency: "USD", balance, debit: null, credit: null, asOf: null, dimensions: {}, ...over,
});
async function setup(t: TenantId) {
  await ds.commands.upsertProgram(t, { programId: "BS", type: "BALANCE_SHEET", enabled: true });
  await ds.commands.upsertProgram(t, { programId: "CF", type: "CASH_FLOW", enabled: true });
  await ds.commands.addMappingRule({ tenantId: t, programId: "BS", kind: "INCLUDE", target: { type: "NODE", chartCode: "C", nodeCode: "1" }, validFrom: "2026-01-01", validTo: null, by: "test" });
}
const send = (t: TenantId, rows: GlBalanceRow[], asOf: AsOfDate = D1, source = "erp") => ds.commands.submitGlBatch({ tenantId: t, sourceSystem: source, chartCode: "C", asOf, rows, by: "test" });
const included = (t: TenantId, program = "BS", asOf: AsOfDate = D1) => ds.questions.includedBalances({ tenantId: t, programId: programId(program), asOf });
const events = async (t: TenantId) => (await ds.outbox.pending(1000)).filter((e) => e.tenantId === t);

dbTest("balances are stamped, excluded or blocked; only included ones are served", async () => {
  const t = newTenant();
  await setup(t);
  await ds.commands.addMappingRule({ tenantId: t, programId: "BS", kind: "EXCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1100" }, validFrom: "2026-01-01", validTo: null, by: "test" });
  const r = await send(t, [bal("1000", "100.5"), bal("1100", "40"), bal("2000", "7"), bal("1000", "5", { entityCode: "DE1" })]);
  assert.deepEqual([r.status, r.ingestion, r.received, r.included, r.excluded, r.blocked], ["APPLIED", "COMPLETED_WITH_ISSUES", 4, 2, 1, 1]);
  const got = await included(t);
  assert.deepEqual(got.map((b) => [b.entityCode, b.accountNumber, b.amount, b.programId]), [["DE1", "1000", "5.0000", "BS"], ["US1", "1000", "100.5000", "BS"]]);
  assert.deepEqual(got[1]!.lineage, { sourceSystem: "erp", batchId: r.batchId, recordId: "US1|1000|USD|" });
  assert.equal(got[1]!.accountId, "acct-1000");
  assert.equal((await included(t, "CF")).length, 0);
  const issues = await ds.questions.dataQualityIssues(t);
  assert.deepEqual(issues.map((i) => [i.ruleCode, i.status, i.lineage?.recordId]), [["GL_PROGRAM_UNMATCHED", "OPEN", "US1|2000|USD|"]]);
  const ents = await ds.questions.includedBalances({ tenantId: t, programId: programId("BS"), asOf: D1, entityIds: [entityId("ent-DE1")] });
  assert.deepEqual(ents.map((b) => b.entityCode), ["DE1"]);
  assert.deepEqual(await ds.questions.includedBalances({ tenantId: t, programId: programId("BS"), asOf: D1, entityIds: [] }), []);
});

dbTest("each kind of bad row is blocked with its reason and the rest of the batch goes through", async () => {
  const t = newTenant();
  await setup(t);
  const r = await send(t, [
    bal("1000", "1"),
    bal("1000", "1", { entityCode: "XX" }),
    bal("7777", "1"),
    bal("1000", "1", { currency: "XYZ" }),
    bal("1000", "abc", { entityCode: "DE1" }),
    bal("1000", "1", { entityCode: "DE1", currency: "EUR", asOf: "2026-03-04" }),
    bal("1100", "1", { entityCode: null }),
  ]);
  assert.deepEqual([r.included, r.blocked], [1, 6]);
  const codes = (await ds.questions.dataQualityIssues(t)).map((i) => i.ruleCode).sort();
  assert.deepEqual(codes, ["GL_AMOUNT_INVALID", "GL_AS_OF_MISMATCH", "GL_ACCOUNT_UNKNOWN", "GL_CURRENCY_UNSUPPORTED", "GL_ENTITY_MISSING", "GL_ENTITY_UNKNOWN"].sort());
  const blockedRaw = await q(db).selectFrom("balances").select(["raw", "outcome"]).where("tenant_id", "=", t).where("outcome", "=", "BLOCKED").execute();
  assert.equal(blockedRaw.every((b) => b.raw !== null), true, "a blocked row keeps what was sent");
});

dbTest("no source record ID: duplicate keys are blocked, different dimensions are different balances", async () => {
  const t = newTenant();
  await setup(t);
  const r = await send(t, [
    bal("1000", "10"), bal("1000", "10"),
    bal("1100", "1", { dimensions: { costCenter: "A" } }), bal("1100", "2", { dimensions: { costCenter: "B" } }),
    bal("2000", "3"),
  ]);
  assert.deepEqual([r.included, r.blocked], [2, 3], "both duplicates blocked; 2000 has no program");
  const dup = (await ds.questions.dataQualityIssues(t)).filter((i) => i.ruleCode === "GL_DUPLICATE_KEY");
  assert.equal(dup.length, 2);
  const got = await included(t);
  assert.deepEqual(got.map((b) => b.lineage.recordId).sort(), ["US1|1100|USD|costCenter=A", "US1|1100|USD|costCenter=B"]);
  assert.deepEqual(got.find((b) => b.dimensions.costCenter === "B")?.dimensions, { costCenter: "B" });
});

dbTest("debit and credit amounts become one signed amount", async () => {
  const t = newTenant();
  await setup(t);
  await send(t, [bal("1000", null as never, { balance: null, debit: "100", credit: "30.25" })]);
  assert.equal((await included(t))[0]?.amount, "69.7500");
});

dbTest("a repeated batch changes nothing; a new one supersedes it and closes its issues", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "1"), bal("2000", "2")];
  const first = await send(t, rows);
  const again = await send(t, [...rows].reverse());
  assert.deepEqual([again.status, again.batchId, again.blocked], ["DUPLICATE", first.batchId, 1]);
  assert.deepEqual((await events(t)).map((e) => e.type), ["data-source.batch-stamped", "data-source.issues-raised"]);

  const fixed = await send(t, [bal("1000", "1"), bal("1100", "2")]);
  assert.deepEqual([fixed.status, fixed.ingestion], ["APPLIED", "COMPLETED"]);
  const status = await ds.questions.ingestionStatus(t, { sourceSystem: "erp", asOf: D1 });
  assert.deepEqual(status.map((s) => [s.batchId === fixed.batchId, s.current]).sort(), [[false, false], [true, true]]);
  assert.deepEqual((await included(t)).map((b) => b.accountNumber), ["1000", "1100"], "only the current batch is served");
  assert.deepEqual((await ds.questions.dataQualityIssues(t, { status: "OPEN" })), []);
  assert.deepEqual((await ds.questions.dataQualityIssues(t, { status: "RESOLVED" })).map((i) => i.batchId), [first.batchId]);

  const back = await send(t, rows); // the old content again, after a newer batch, is a new batch
  assert.deepEqual([back.status, back.batchId === first.batchId], ["APPLIED", false]);
  assert.deepEqual((await included(t)).map((b) => b.accountNumber), ["1000"]);
});

dbTest("a batch the service cannot take is refused; the usable ones are recorded as FAILED", async () => {
  const t = newTenant();
  await setup(t);
  await assert.rejects(send(t, [bal("1000", "1")], D1, "bad source!"), (e: unknown) => e instanceof BatchRefused && e.batchId === null);
  await assert.rejects(send(t, [bal("1000", "1")], "2026-02-30" as AsOfDate), BatchRefused);
  const empty = await send(t, []).catch((e: BatchRefused) => e);
  assert.ok(empty instanceof BatchRefused && empty.batchId !== null);
  await assert.rejects(send(t, [bal("1000", "1")], asOfDate("2026-03-11")), /future/);
  const failed = await ds.questions.ingestionStatus(t);
  assert.deepEqual(failed.map((s) => [s.status, s.current]), [["FAILED", false], ["FAILED", false]]);
  assert.match(failed[0]!.failureReason ?? "", /./);
  assert.deepEqual(await events(t), []);
  const ok = await send(t, [bal("1000", "1")]);
  assert.equal(ok.status, "APPLIED", "a failed batch does not block or supersede anything");
});

dbTest("a program that is unknown, disabled or in conflict blocks the balance", async () => {
  const t = newTenant();
  await setup(t);
  await ds.commands.upsertProgram(t, { programId: "BS", type: "BALANCE_SHEET", enabled: false });
  assert.deepEqual((await send(t, [bal("1000", "1")])).blocked, 1);
  assert.deepEqual((await ds.questions.dataQualityIssues(t)).map((i) => i.ruleCode), ["GL_PROGRAM_NOT_ACTIVE"]);
  await ds.commands.upsertProgram(t, { programId: "BS", type: "BALANCE_SHEET", enabled: true });
  assert.equal((await send(t, [bal("1000", "1")], D2)).included, 1);

  // two programs claiming one account: refused on save, and blocked at intake if it ever gets through
  await assert.rejects(
    ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1000" }, validFrom: "2026-02-01", validTo: null, by: "test" }),
    (e: unknown) => e instanceof RuleInvalid && /both claim C:1000/.test(e.message),
  );
  await q(db).insertInto("mapping_rules").values({
    tenant_id: t, rule_id: randomUUID(), program_id: "CF", kind: "INCLUDE", target_type: "ACCOUNT", chart_code: "C", target_code: "1000",
    valid_from: "2026-01-01", valid_to: null, source_system: null, entity_code: null, dimensions: null, created_by: "test",
  }).execute();
  assert.equal((await send(t, [bal("1000", "1")], asOfDate("2026-03-07"))).blocked, 1);
  assert.deepEqual((await ds.questions.dataQualityIssues(t, { asOf: asOfDate("2026-03-07") })).map((i) => i.ruleCode), ["GL_PROGRAM_MULTI_MATCH"]);
});

dbTest("rules: overlap check respects scope, excludes and dates; rules can be ended", async () => {
  const t = newTenant();
  await setup(t); // BS includes node 1 (accounts 1000 and 1100), for every source
  const add = (over: object) => ds.commands.addMappingRule({
    tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1000" }, validFrom: "2026-01-01", validTo: null, by: "test", ...over,
  } as never);
  const bsExcludes = (accountNumber: string) => ds.commands.addMappingRule({ tenantId: t, programId: "BS", kind: "EXCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber }, validFrom: "2026-01-01", validTo: null, by: "test" });
  await assert.rejects(add({ sourceSystem: "tms" }), /both claim C:1000/, "BS takes every source, so a TMS-only rule still clashes");
  await bsExcludes("1000");
  await add({ sourceSystem: "tms" }); // BS now excludes 1000, so CF may take it
  await assert.rejects(add({ target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1100" } }), /both claim C:1100/);
  await bsExcludes("1100");
  await add({ target: { type: "NODE", chartCode: "C", nodeCode: "11" } });
  await add({ target: { type: "ACCOUNT", chartCode: "C", accountNumber: "2000" } }); // outside BS's node: no overlap at all

  // dates: once BS's rule has ended, a CF rule on the same node may start that day
  const t2 = newTenant();
  await setup(t2);
  const bs = await q(db).selectFrom("mapping_rules").select("rule_id").where("tenant_id", "=", t2).where("program_id", "=", "BS").executeTakeFirstOrThrow();
  const cfNode = (from: string) => ds.commands.addMappingRule({ tenantId: t2, programId: "CF", kind: "INCLUDE", target: { type: "NODE", chartCode: "C", nodeCode: "1" }, validFrom: from, validTo: null, by: "test" });
  await assert.rejects(cfNode("2026-02-01"), /both claim/);
  await ds.commands.endMappingRule(t2, bs.rule_id, "2026-02-01");
  await cfNode("2026-02-01");
  await assert.rejects(ds.commands.endMappingRule(t2, bs.rule_id, "2026-03-01"), RuleInvalid, "a rule can only be shortened");
  await assert.rejects(ds.commands.endMappingRule(t2, bs.rule_id, "2025-12-01"), RuleInvalid);

  // scope: a rule for another source system does not clash with one scoped to a different source
  const t3 = newTenant();
  await ds.commands.upsertProgram(t3, { programId: "BS", type: "BALANCE_SHEET", enabled: true });
  await ds.commands.upsertProgram(t3, { programId: "CF", type: "CASH_FLOW", enabled: true });
  await ds.commands.addMappingRule({ tenantId: t3, programId: "BS", kind: "INCLUDE", target: { type: "NODE", chartCode: "C", nodeCode: "1" }, validFrom: "2026-01-01", validTo: null, sourceSystem: "erp", by: "test" });
  await ds.commands.addMappingRule({ tenantId: t3, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1000" }, validFrom: "2026-01-01", validTo: null, sourceSystem: "tms", by: "test" });

  await assert.rejects(add({ programId: "NOPE" }), /not in the catalog/);
  await assert.rejects(add({ validTo: "2025-01-01" }), /after valid-from/);
  await assert.rejects(add({ validFrom: "2026-13-01" }), /not a date/);
  await assert.rejects(add({ dimensions: { cc: [] } }), /needs one or more values/);
});

dbTest("a TMS balance can replace the ERP one through source-scoped rules", async () => {
  const t = newTenant();
  await ds.commands.upsertProgram(t, { programId: "BS", type: "BALANCE_SHEET", enabled: true });
  await ds.commands.upsertProgram(t, { programId: "CF", type: "CASH_FLOW", enabled: true });
  const rule = (programId: string, sourceSystem: string) => ds.commands.addMappingRule({ tenantId: t, programId, kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1000" }, validFrom: "2026-01-01", validTo: null, sourceSystem, by: "test" });
  await rule("BS", "erp");
  await rule("CF", "tms");
  await send(t, [bal("1000", "10")], D1, "erp");
  await send(t, [bal("1000", "11")], D1, "tms");
  assert.deepEqual((await included(t, "BS")).map((b) => [b.lineage.sourceSystem, b.amount]), [["erp", "10.0000"]]);
  assert.deepEqual((await included(t, "CF")).map((b) => [b.lineage.sourceSystem, b.amount]), [["tms", "11.0000"]]);
  assert.equal((await ds.questions.includedBalances({ tenantId: t, programId: programId("CF"), asOf: D1, sourceSystem: "erp" })).length, 0);
});

dbTest("tenant isolation", async () => {
  const a = newTenant();
  const b = newTenant();
  await setup(a);
  await setup(b);
  await send(a, [bal("1000", "1")]);
  assert.equal((await included(a)).length, 1);
  assert.equal((await included(b)).length, 0);
  assert.deepEqual(await ds.questions.ingestionStatus(b), []);
  assert.deepEqual(await ds.questions.dataQualityIssues(b), []);
  const aBlocked = newTenant();
  assert.equal((await send(aBlocked, [bal("1000", "1")])).blocked, 1, "no rules in a tenant that has none");
});

dbTest("events carry identifiers only; the same batch at the same moment is applied once", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "1"), bal("2000", "2")];
  const results = await Promise.all([1, 2, 3].map(() => send(t, rows)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["APPLIED", "DUPLICATE", "DUPLICATE"]);
  const ev = await events(t);
  assert.equal(ev.length, 2);
  assert.deepEqual(Object.keys(ev.find((e) => e.type === "data-source.batch-stamped")!).sort(), ["asOf", "batchId", "eventId", "occurredAt", "sourceSystem", "tenantId", "type"]);
  assert.deepEqual(Object.keys(ev.find((e) => e.type === "data-source.issues-raised")!).sort(), ["batchId", "eventId", "occurredAt", "tenantId", "type"]);
  await ds.outbox.markPublished(ev.map((e) => e.eventId));
  assert.deepEqual(await events(t), []);
});

dbTest("the database refuses an included balance without a program", async () => {
  const t = newTenant();
  await setup(t);
  const r = await send(t, [bal("1000", "1")]);
  await assert.rejects(
    q(db).insertInto("balances").values({
      tenant_id: t, balance_id: randomUUID(), batch_id: r.batchId, source_system: "erp", as_of: D1, row_number: 99, record_key: "x", entity_code: null, entity_id: null,
      chart_code: "C", account_number: null, account_id: null, currency: null, amount: null, dimensions: "{}", outcome: "INCLUDED", program_id: null, matched_rule_ids: "[]", raw: null,
    }).execute(),
    /check/i,
  );
});
