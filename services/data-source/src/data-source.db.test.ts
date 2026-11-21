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
  async getPairExposureCurrencies() { return []; },
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

dbTest("control totals: each currency's received total equals its included, excluded and blocked totals added together", async () => {
  const t = newTenant();
  await setup(t);
  await ds.commands.addMappingRule({ tenantId: t, programId: "BS", kind: "EXCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "1100" }, validFrom: "2026-01-01", validTo: null, by: "test" });
  const r = await send(t, [
    bal("1000", "100.50"), // USD, included
    bal("1100", "40"), // USD, excluded by the rule above
    bal("2000", "7"), // USD, blocked: no program claims it
    bal("1000", "5", { currency: "EUR" }), // EUR, included
    bal("1000", "3", { currency: null as never }), // no currency: blocked
    bal("1000", "abc", { entityCode: "DE1" }), // USD, blocked: amount does not parse, so it contributes 0 to the sum
  ]);
  assert.deepEqual([r.received, r.included, r.excluded, r.blocked], [6, 2, 1, 3]);
  const totals = await ds.questions.controlTotals(t, r.batchId);
  assert.deepEqual(totals, [
    { currency: "", receivedRows: 1, receivedSum: "3.0000", includedRows: 0, includedSum: "0.0000", excludedRows: 0, excludedSum: "0.0000", blockedRows: 1, blockedSum: "3.0000" },
    { currency: "EUR", receivedRows: 1, receivedSum: "5.0000", includedRows: 1, includedSum: "5.0000", excludedRows: 0, excludedSum: "0.0000", blockedRows: 0, blockedSum: "0.0000" },
    { currency: "USD", receivedRows: 4, receivedSum: "147.5000", includedRows: 1, includedSum: "100.5000", excludedRows: 1, excludedSum: "40.0000", blockedRows: 2, blockedSum: "7.0000" },
  ]);
  for (const g of totals) {
    assert.equal(g.receivedRows, g.includedRows + g.excludedRows + g.blockedRows, `${g.currency}: rows add up`);
    assert.equal(g.receivedSum, (Number(g.includedSum) + Number(g.excludedSum) + Number(g.blockedSum)).toFixed(4), `${g.currency}: sums add up`);
  }
  assert.equal(totals.reduce((n, g) => n + g.receivedRows, 0), r.received, "every group's rows sum to the whole batch");
});

dbTest("control totals: a duplicate batch returns the same totals as the one it duplicates", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "10"), bal("1100", "20"), bal("2000", "5")];
  const first = await send(t, rows);
  const before = await ds.questions.controlTotals(t, first.batchId);
  const dup = await send(t, [...rows].reverse());
  assert.deepEqual([dup.status, dup.batchId], ["DUPLICATE", first.batchId]);
  assert.deepEqual(await ds.questions.controlTotals(t, dup.batchId), before);
});

dbTest("control totals: a batch that does not exist, or belongs to another tenant, is refused without naming either", async () => {
  const t = newTenant();
  const other = newTenant();
  await setup(t);
  await setup(other);
  const r = await send(t, [bal("1000", "1")]);
  const missing = randomUUID();
  const notFound = await ds.questions.controlTotals(t, missing).catch((e: unknown) => e);
  assert.ok(notFound instanceof Error);
  assert.doesNotMatch(notFound.message, new RegExp(missing));
  const crossTenant = await ds.questions.controlTotals(other, r.batchId).catch((e: unknown) => e);
  assert.ok(crossTenant instanceof Error);
  assert.doesNotMatch(crossTenant.message, new RegExp(r.batchId));
  assert.equal(notFound.message, crossTenant.message, "the two cases are indistinguishable from the message alone");
});

dbTest("expectedTotals: a batch whose totals match is accepted exactly as one sent with no expectedTotals", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "100.50"), bal("1100", "40"), bal("1000", "5", { currency: "EUR" })];
  const r = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 2, sum: "140.50" }, { currency: "EUR", rowCount: 1, sum: "5" }],
  });
  assert.deepEqual([r.status, r.received, r.included, r.excluded, r.blocked], ["APPLIED", 3, 3, 0, 0]);
});

dbTest("expectedTotals: each kind of difference refuses the batch and stores it as FAILED; a batch with none is unaffected", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "100.50"), bal("1100", "40")]; // USD: 2 rows, 140.50, both included
  const refuse = async (expectedTotals: { currency: string; rowCount: number; sum: string }[]) => {
    const err: unknown = await ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test", expectedTotals }).catch((e: unknown) => e);
    assert.ok(err instanceof BatchRefused && err.batchId !== null, "refused and recorded, not silently dropped");
    return err.batchId!;
  };
  const wrongSum = await refuse([{ currency: "USD", rowCount: 2, sum: "999.00" }]);
  const wrongCount = await refuse([{ currency: "USD", rowCount: 5, sum: "140.50" }]);
  const expectedButNotReceived = await refuse([{ currency: "USD", rowCount: 2, sum: "140.50" }, { currency: "GBP", rowCount: 1, sum: "1.00" }]); // GBP: expected, none arrived
  const receivedButNotExpected = await refuse([]); // the sender expected no currencies at all; USD arrived anyway

  const statuses = await ds.questions.ingestionStatus(t, { asOf: D1 });
  for (const id of [wrongSum, wrongCount, expectedButNotReceived, receivedButNotExpected]) {
    const s = statuses.find((x) => x.batchId === id)!;
    assert.deepEqual([s.status, s.current], ["FAILED", false]);
    assert.match(s.failureReason ?? "", /control totals do not match/);
  }
  assert.match(statuses.find((s) => s.batchId === expectedButNotReceived)!.failureReason!, /GBP: expected 1 rows.*not received/);
  assert.match(statuses.find((s) => s.batchId === receivedButNotExpected)!.failureReason!, /USD: received 2 rows.*not expected/);
  assert.deepEqual(await events(t), [], "nothing is announced for a refused batch");
  assert.deepEqual(await ds.questions.dataQualityIssues(t), [], "no balances or issues are stored for a refused batch");

  // the same rows, sent with no expectedTotals, behave exactly as before this task
  const plain = await send(t, rows, D1);
  assert.deepEqual([plain.status, plain.included], ["APPLIED", 2]);
});

dbTest("expectedTotals: a currency never received is a difference even when claimed as an explicit zero", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "100.50"), bal("1100", "40")]; // USD only
  const err: unknown = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 2, sum: "140.50" }, { currency: "EUR", rowCount: 0, sum: "0.00" }],
  }).catch((e: unknown) => e);
  assert.ok(err instanceof BatchRefused && err.batchId !== null);
  const s = (await ds.questions.ingestionStatus(t, { asOf: D1 })).find((x) => x.batchId === err.batchId)!;
  assert.equal(s.status, "FAILED");
  assert.match(s.failureReason!, /EUR: expected 0 rows \/ 0\.00, not received/);
  assert.deepEqual(await ds.questions.dataQualityIssues(t), [], "no balances stored for the refused batch");
});

dbTest("expectedTotals: a duplicate currency, a bad rowCount or a malformed sum refuses the batch before anything is received", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "1")];
  const refuse = async (expectedTotals: unknown) => {
    const err: unknown = await ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test", expectedTotals: expectedTotals as never }).catch((e: unknown) => e);
    assert.ok(err instanceof BatchRefused && err.batchId !== null);
    return (await ds.questions.ingestionStatus(t, { asOf: D1 })).find((x) => x.batchId === err.batchId)!.failureReason!;
  };
  assert.match(await refuse([{ currency: "USD", rowCount: 1, sum: "1" }, { currency: "USD", rowCount: 2, sum: "2" }]), /USD is listed more than once/);
  assert.match(await refuse([{ currency: "USD", rowCount: -1, sum: "1" }]), /rowCount must be a whole number/);
  assert.match(await refuse([{ currency: "USD", rowCount: 1, sum: "not-a-number" }]), /sum must be a decimal amount/);
  assert.deepEqual(await ds.questions.dataQualityIssues(t), []);
});

dbTest("expectedTotals: a resend behind an unchanged content hash is still checked; matching totals stay DUPLICATE, a mismatch refuses a new attempt without touching the original", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", "100.50"), bal("1100", "40")]; // USD: 2 rows, 140.50
  const first = await ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test" }); // no expectedTotals the first time
  assert.equal(first.status, "APPLIED");

  const dup = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows: [...rows].reverse(), by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 2, sum: "140.50" }],
  });
  assert.deepEqual([dup.status, dup.batchId], ["DUPLICATE", first.batchId], "matching totals: still the same duplicate batch");

  const err: unknown = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 2, sum: "999.00" }],
  }).catch((e: unknown) => e);
  assert.ok(err instanceof BatchRefused && err.batchId !== null && err.batchId !== first.batchId, "a mismatch is a new, separate FAILED attempt");

  const statuses = await ds.questions.ingestionStatus(t, { asOf: D1 });
  const originalAfter = statuses.find((s) => s.batchId === first.batchId)!;
  assert.deepEqual([originalAfter.status, originalAfter.current], ["COMPLETED", true], "the original batch is untouched: not superseded, still current");
  const failedAttempt = statuses.find((s) => s.batchId === err.batchId)!;
  assert.deepEqual([failedAttempt.status, failedAttempt.current], ["FAILED", false]);
  assert.deepEqual((await events(t)).map((e) => e.type), ["data-source.batch-stamped"], "nothing new is announced for either the duplicate or the refused resend");
});

dbTest("control totals reconcile to 4 decimals across many rows of large signed amounts", async () => {
  const t = newTenant();
  await setup(t);
  // Near the 20-integer-digit limit, where decimal.js's default 20-significant-digit precision would round a sum.
  const amounts = ["12345678901234567890.1234", "1.0001", "-11111111111111111111.1234", "0.0001"];
  const rows = amounts.map((a, i) => bal("1000", a, { dimensions: { row: String(i) } }));
  const r = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 4, sum: "1234567790123456780.0002" }],
  });
  assert.equal(r.status, "APPLIED", "the expected sum, computed with exact decimal arithmetic, is accepted");
  const [usd] = await ds.questions.controlTotals(t, r.batchId);
  assert.deepEqual([usd!.receivedRows, usd!.receivedSum], [4, "1234567790123456780.0002"]);
  assert.equal(usd!.receivedSum, usd!.includedSum, "all four rows included; the group sums still reconcile exactly");
});

dbTest("debit minus credit keeps full precision too, not only the balance-column sum path", async () => {
  const t = newTenant();
  await setup(t);
  const rows = [bal("1000", null as never, { balance: null, debit: "12345678901234567890.1234", credit: "0.0001" })];
  const r = await ds.commands.submitGlBatch({
    tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows, by: "test",
    expectedTotals: [{ currency: "USD", rowCount: 1, sum: "12345678901234567890.1233" }],
  });
  assert.equal(r.status, "APPLIED", "the exact expected total, computed the same way, is accepted");
  const [usd] = await ds.questions.controlTotals(t, r.batchId);
  assert.equal(usd!.receivedSum, "12345678901234567890.1233", "the reported total is exact, not rounded at normalization");
  assert.equal((await included(t))[0]?.amount, "12345678901234567890.1233");
});

dbTest("control totals answer well within budget at UAT size (20,000 rows, 40 currencies)", async () => {
  const t = newTenant();
  await setup(t);
  const currencies = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SGD", "HKD", "CNY", "CNH", "INR", "KRW", "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK",
    "PLN", "TRY", "THB", "IDR", "MYR", "PHP", "AED", "SAR", "ILS", "TWD", "CZK", "HUF", "RON", "CLP", "COP", "PEN", "EGP", "QAR", "KWD", "BHD"];
  assert.equal(currencies.length, 40);
  const rows: GlBalanceRow[] = Array.from({ length: 20_000 }, (_, i) => bal("1000", "1.23", { currency: currencies[i % 40], dimensions: { row: String(i) } }));
  const r = await send(t, rows, asOfDate("2026-03-09"));
  assert.deepEqual([r.received, r.included], [20_000, 20_000]);
  const started = Date.now();
  const totals = await ds.questions.controlTotals(t, r.batchId);
  const elapsedMs = Date.now() - started;
  assert.equal(totals.length, 40);
  assert.equal(totals.reduce((n, g) => n + g.receivedRows, 0), 20_000);
  assert.ok(elapsedMs < 500, `controlTotals took ${elapsedMs}ms, over the 500ms budget for a 20,000-row batch`);
});

dbTest("audit: a batch loaded by a person is recorded once; a connector feed and a duplicate record nothing", async () => {
  const t = newTenant();
  await setup(t);
  const byUser = (rows: GlBalanceRow[], asOf: AsOfDate = D1) => ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf, rows, by: "user:alice" });

  const connector = await send(t, [bal("1000", "1")]); // by: "test" - not a person
  assert.deepEqual(await recordsOf(t), [], "a connector feed is a routine load");

  const r = await byUser([bal("1000", "2")], D2);
  const rs = await recordsOf(t);
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0]!.programId, rs[0]!.actor, rs[0]!.action, rs[0]!.targetType, rs[0]!.targetId, rs[0]!.fields], [null, "user:alice", "batch.loaded", "batch", r.batchId, []]);

  const dup = await ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D2, rows: [bal("1000", "2")], by: "user:alice" });
  assert.equal(dup.status, "DUPLICATE");
  assert.equal((await recordsOf(t)).length, 1, "a repeat that changes nothing records nothing more");
  assert.equal(connector.status, "APPLIED");
});

dbTest("audit: a refused batch records nothing", async () => {
  const t = newTenant();
  await setup(t);
  await assert.rejects(ds.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: D1, rows: [], by: "user:alice" }), BatchRefused);
  assert.deepEqual(await recordsOf(t), [], "a batch the service could not take is not a load");
});

dbTest("audit: mapping rules record who added and ended them; endMappingRule needs a by", async () => {
  const t = newTenant();
  await setup(t);
  await ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "2000" }, validFrom: "2026-01-01", validTo: null, by: "test" });
  assert.deepEqual(await recordsOf(t), [], "added by a routine feed, not a person");

  const added = await ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "9000" }, validFrom: "2026-01-01", validTo: null, by: "user:alice" });
  let rs = await recordsOf(t);
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0]!.programId, rs[0]!.actor, rs[0]!.action, rs[0]!.targetType, rs[0]!.targetId, rs[0]!.fields], ["CF", "user:alice", "mapping-rule.added", "mapping-rule", added, []]);

  await ds.commands.endMappingRule(t, added, "2026-06-01", "user:bob");
  rs = await recordsOf(t);
  assert.equal(rs.length, 2);
  assert.deepEqual([rs[1]!.programId, rs[1]!.actor, rs[1]!.action, rs[1]!.targetType, rs[1]!.targetId, rs[1]!.fields], ["CF", "user:bob", "mapping-rule.ended", "mapping-rule", added, ["validTo"]]);
});

dbTest("audit: ending a rule by a routine feed records nothing; a refused end records nothing", async () => {
  const t = newTenant();
  await setup(t);
  const added = await ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "9000" }, validFrom: "2026-01-01", validTo: null, by: "test" });
  await ds.commands.endMappingRule(t, added, "2026-06-01", "test");
  assert.deepEqual(await recordsOf(t), []);
  await assert.rejects(ds.commands.endMappingRule(t, added, "2025-01-01", "user:alice"), RuleInvalid);
  assert.deepEqual(await recordsOf(t), [], "a refused end is not a change");
});

dbTest("endMappingRule: two concurrent ends of the same rule are serialized; the final date is never silently widened", async () => {
  // Run several times so both lock-acquisition orders are exercised, not just whichever happens to win once.
  for (let i = 0; i < 8; i++) {
    const t = newTenant();
    await setup(t);
    const ruleId = await ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "9000" }, validFrom: "2026-01-01", validTo: null, by: "test" });
    const [toMarch, toJune] = await Promise.allSettled([
      ds.commands.endMappingRule(t, ruleId, "2026-03-01", "user:alice"), // always a valid shortening, whichever order the lock gives
      ds.commands.endMappingRule(t, ruleId, "2026-06-01", "user:bob"), // valid only if it runs first, against the rule's still-open end
    ]);
    const row = await q(db).selectFrom("mapping_rules").select("valid_to").where("tenant_id", "=", t).where("rule_id", "=", ruleId).executeTakeFirstOrThrow();
    assert.equal(row.valid_to, "2026-03-01", "the more aggressive, still-valid shortening always wins in the end, whichever call ran first");
    assert.equal(toMarch!.status, "fulfilled", "2026-03-01 is a valid shortening whether it ran first or second");
    if (toJune!.status === "rejected") assert.match((toJune as PromiseRejectedResult).reason.message, /only.*shortened/);
    const ended = (await recordsOf(t)).filter((r) => r.action === "mapping-rule.ended");
    const succeeded = [toMarch, toJune].filter((r) => r!.status === "fulfilled").length;
    assert.equal(ended.length, succeeded, "one audit record per call that actually committed; none for the one the lock correctly refused");
  }
});

dbTest("audit: the business write and the announcement commit or fail together; moving the announcement after the transaction breaks this", async () => {
  const t = newTenant();
  await setup(t);
  const ruleId = await ds.commands.addMappingRule({ tenantId: t, programId: "CF", kind: "INCLUDE", target: { type: "ACCOUNT", chartCode: "C", accountNumber: "9000" }, validFrom: "2026-01-01", validTo: null, by: "test" });

  const failOutboxInserts: KyselyPlugin = {
    transformQuery: (args) => {
      if (args.node.kind === "InsertQueryNode" && JSON.stringify(args.node).includes('"outbox"')) throw new Error("simulated: the outbox write failed");
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
  const brokenDb = db.withPlugin(failOutboxInserts);
  const broken = createDataSource(brokenDb, { masterData: md, now: () => clock });

  await assert.rejects(broken.commands.endMappingRule(t, ruleId, "2026-06-01", "user:alice"), /simulated: the outbox write failed/);
  const row = await q(db).selectFrom("mapping_rules").select("valid_to").where("tenant_id", "=", t).where("rule_id", "=", ruleId).executeTakeFirstOrThrow();
  assert.equal(row.valid_to, null, "the rule was not shortened: the failed announcement rolled back the business write too");
  assert.deepEqual(await recordsOf(t), [], "no change record exists for a change that did not commit");
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
