// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// master_data schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import type { MasterDataEvents } from "../contract/index.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, entityId, programId, tenantId, type EntityId, type TenantId } from "@shared/kernel";
import { migrate } from "../../../scripts/migrate.mjs";
import { ChangeSetInvalid, ChangeSetRefused, connect, createMasterData, type AccountRow, type Db, type EntityRow, type HierarchyNodeRow } from "./index.ts";
import { q } from "./db.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("master data database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

let db: Db;
let md: ReturnType<typeof createMasterData>;
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("master_data").ifExists().cascade().execute();
  await migrate(url!);
  md = createMasterData(db);
});
after(async () => {
  if (enabled) await db.destroy();
});

const D1 = asOfDate("2026-01-01");
const D2 = asOfDate("2026-03-01");
const D3 = asOfDate("2026-06-01");
const newTenant = () => tenantId(randomUUID());
const ent = (code: string, over: Partial<EntityRow> = {}): EntityRow => ({
  code, name: `Entity ${code}`, type: "BUSINESS_UNIT", parentCode: null, countryCode: null, functionalCurrency: null,
  isLegalEntity: false, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over,
});
const legal = (code: string, currency: string, parentCode: string | null = null): EntityRow =>
  ent(code, { type: "LEGAL_ENTITY", isLegalEntity: true, functionalCurrency: currency, parentCode, countryCode: "US" });
const node = (code: string, parentCode: string | null, chartCode = "C"): HierarchyNodeRow => ({ chartCode, code, name: code, classification: "ASSETS", parentCode });
const acct = (accountNumber: string, hierarchyNodeCode: string | null, name = `Account ${accountNumber}`): AccountRow => ({
  chartCode: "C", accountNumber, name, statementType: "BALANCE_SHEET", normalBalance: "DEBIT", monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode,
});
const snap = <R>(tenant: TenantId, rows: R[], asOf = D1, source = "erp") => ({ tenantId: tenant, sourceSystem: source, asOf, mode: "SNAPSHOT" as const, rows, by: "test" });
const part = <R>(tenant: TenantId, rows: R[], asOf = D1, source = "manual") => ({ tenantId: tenant, sourceSystem: source, asOf, mode: "PARTIAL" as const, rows, by: "test" });
const events = async (t: TenantId) => {
  const changed: Extract<MasterDataEvents, { type: "master-data.changed" }>[] = []; // the announcement other services use; change records are checked in the Audit tests
  for (const e of await md.outbox.pending(1000)) if (e.tenantId === t && e.type === "master-data.changed") changed.push(e);
  return changed;
};

dbTest("history: a lookup reads the version valid on the date, and the id stays the same", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("G"), legal("US1", "USD", "G")], D1));
  await md.commands.applyEntities(snap(t, [ent("G"), { ...legal("US1", "EUR", "G"), name: "US1 renamed" }], D2));

  const before1 = await md.questions.getEntity(t, "US1", D1);
  const mid = await md.questions.getEntity(t, "US1", asOfDate("2026-02-15"));
  const after2 = await md.questions.getEntity(t, "US1", D2);
  assert.equal(before1?.functionalCurrency, "USD");
  assert.equal(mid?.functionalCurrency, "USD", "still the old version the day before the change");
  assert.equal(after2?.functionalCurrency, "EUR");
  assert.equal(after2?.name, "US1 renamed");
  assert.equal(after2?.entityId, before1?.entityId, "one entity, two versions");
  assert.equal(await md.questions.getEntity(t, "US1", asOfDate("2025-12-31")), null);

  const g = (await md.questions.getEntity(t, "G", D2))!;
  assert.equal(after2?.parentEntityId, g.entityId);
  assert.deepEqual((await md.questions.functionalCurrencies(t, [after2!.entityId, g.entityId], D1)).map((x) => x.currency).sort(), ["USD", null]);
  assert.deepEqual((await md.questions.functionalCurrencies(t, [after2!.entityId], D3)).map((x) => x.currency), ["EUR"]);
});

dbTest("entity walks go down and up the tree as of a date", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("G"), ent("R", { type: "REGION", parentCode: "G" }), legal("A", "USD", "R"), legal("B", "GBP", "R")], D1));
  await md.commands.applyEntities(snap(t, [ent("G"), ent("R", { type: "REGION", parentCode: "G" }), legal("A", "USD", "R")], D2)); // B leaves
  const g = (await md.questions.getEntity(t, "G", D1))!;
  const a = (await md.questions.getEntity(t, "A", D1))!;
  assert.deepEqual((await md.questions.entityWalk(t, g.entityId, "descendants", D1)).map((e) => e.code), ["R", "A", "B"]);
  assert.deepEqual((await md.questions.entityWalk(t, g.entityId, "descendants", D2)).map((e) => e.code), ["R", "A"]);
  assert.deepEqual((await md.questions.entityWalk(t, a.entityId, "ancestors", D2)).map((e) => e.code), ["R", "G"]);
});

dbTest("a repeated snapshot changes nothing; other content, an older date or bad rows are refused", async () => {
  const t = newTenant();
  const rows = [ent("G"), ent("H")];
  const first = await md.commands.applyEntities(snap(t, rows, D2));
  assert.equal(first.status, "APPLIED");
  assert.equal(first.created, 2);
  const again = await md.commands.applyEntities(snap(t, rows, D2));
  assert.equal(again.status, "DUPLICATE");
  assert.equal(again.batchId, first.batchId);
  assert.equal((await events(t)).length, 1, "one event, not two");

  await assert.rejects(md.commands.applyEntities(snap(t, [ent("G")], D2)), ChangeSetRefused, "same key, other content");
  await assert.rejects(md.commands.applyEntities(snap(t, rows, D1)), ChangeSetRefused, "would rewrite history");
  await assert.rejects(md.commands.applyEntities(snap(t, [ent("X", { parentCode: "NOPE" })], D3)), ChangeSetInvalid);
  assert.equal(await md.questions.getEntity(t, "X", D3), null, "an invalid change set writes nothing");
  assert.equal((await events(t)).length, 1);

  const same = await md.commands.applyEntities(snap(t, rows, D3));
  assert.deepEqual([same.status, same.created, same.changed, same.ended, same.unchanged], ["APPLIED", 0, 0, 0, 2]);
  assert.equal((await events(t)).length, 1, "nothing changed, so nothing announced");
});

dbTest("events carry identifiers only", async () => {
  const t = newTenant();
  const r = await md.commands.applyEntities(snap(t, [ent("G")], D1));
  const [e] = await events(t);
  assert.deepEqual(Object.keys(e!).sort(), ["asOf", "batchId", "eventId", "kind", "occurredAt", "tenantId", "type"]);
  assert.equal(e!.batchId, r.batchId);
  await md.outbox.markPublished([e!.eventId]);
  assert.deepEqual(await events(t), []);
});

dbTest("safeguard: a snapshot that ends too much is held, then released or rejected", async () => {
  const t = newTenant();
  const codes = Array.from({ length: 20 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`);
  await md.commands.applyEntities(snap(t, codes.map((c) => ent(c)), D1));
  await md.commands.applyEntities(part(t, [ent("MANUAL")], D1)); // a manual row, never ended by the ERP

  const held = await md.commands.applyEntities(snap(t, codes.slice(0, 14).map((c) => ent(c)), D2));
  assert.equal(held.status, "HELD");
  assert.match(held.heldReason ?? "", /6 of 20/);
  assert.equal((await md.questions.getEntity(t, "E20", D3))?.code, "E20", "nothing was applied");
  assert.equal((await events(t)).length, 2, "no event for a held snapshot");
  assert.equal((await md.commands.heldChangeSets(t)).length, 1);
  const repeat = await md.commands.applyEntities(snap(t, codes.slice(0, 14).map((c) => ent(c)), D2));
  assert.equal(repeat.status, "HELD");
  assert.equal(repeat.batchId, held.batchId, "sending it again does not queue a second copy");

  const released = await md.commands.releaseChangeSet(t, held.batchId, "reviewer");
  assert.deepEqual([released.status, released.ended], ["APPLIED", 6]);
  assert.equal(await md.questions.getEntity(t, "E20", D3), null);
  assert.equal(await md.questions.getEntity(t, "E20", D1).then((e) => e?.code), "E20", "history keeps it");
  assert.equal((await md.questions.getEntity(t, "MANUAL", D3))?.code, "MANUAL");
  assert.equal((await md.commands.heldChangeSets(t)).length, 0);
  assert.equal((await events(t)).length, 3);
  await assert.rejects(md.commands.releaseChangeSet(t, held.batchId, "reviewer"), ChangeSetRefused, "already decided");

  const second = await md.commands.applyEntities(snap(t, [ent("E01"), ent("E02")], D3)); // 12 of 14 ended
  assert.equal(second.status, "HELD");
  await md.commands.rejectChangeSet(t, second.batchId, "reviewer");
  assert.equal(await md.questions.getEntity(t, "E05", D3).then((e) => e?.code), "E05", "rejected: nothing applied");
  const retry = await md.commands.applyEntities(snap(t, codes.slice(0, 14).map((c) => ent(c)), D3));
  assert.equal(retry.status, "APPLIED", "a rejected snapshot's key can be used again");
});

dbTest("safeguard: the share is a per-tenant setting, and small sets are never held", async () => {
  const t = newTenant();
  const codes = Array.from({ length: 20 }, (_, i) => `E${i}`);
  await md.commands.applyEntities(snap(t, codes.map((c) => ent(c)), D1));
  await md.commands.setMaxEndShare(t, 0.5);
  assert.equal((await md.commands.applyEntities(snap(t, codes.slice(0, 12).map((c) => ent(c)), D2))).status, "APPLIED");
  await md.commands.setMaxEndShare(t, 0);
  assert.equal((await md.commands.applyEntities(snap(t, codes.slice(0, 11).map((c) => ent(c)), D3))).status, "HELD");

  const small = newTenant();
  await md.commands.applyEntities(snap(small, [ent("A"), ent("B"), ent("C")], D1));
  assert.equal((await md.commands.applyEntities(snap(small, [ent("A")], D2))).status, "APPLIED", "fewer than 10 open rows");
  await assert.rejects(md.commands.setMaxEndShare(t, 1.5), RangeError);
});

dbTest("hierarchy and accounts: walks, versions and references", async () => {
  const t = newTenant();
  await md.commands.applyHierarchy(snap(t, [node("1", null), node("11", "1"), node("111", "11"), node("2", null)]));
  await md.commands.applyAccounts(snap(t, [acct("1000", "111"), acct("1100", "11"), acct("2000", "2"), acct("9000", null)]));

  const under1 = await md.questions.accountsUnderNode(t, "C", "1", D1);
  assert.deepEqual(under1.map((a) => a.accountNumber), ["1000", "1100"]);
  assert.deepEqual((await md.questions.accountsUnderNode(t, "C", "111", D1)).map((a) => a.accountNumber), ["1000"]);
  assert.deepEqual(await md.questions.accountsUnderNode(t, "C", "nope", D1), []);
  const a1000 = (await md.questions.getAccount(t, "C", "1000", D1))!;
  assert.equal(a1000.hierarchyNodeCode, "111");
  assert.equal(await md.questions.getAccount(t, "OTHER", "1000", D1), null);

  // the account moves to another node and is renamed on D2; the id is unchanged and history keeps the old node
  await md.commands.applyAccounts(snap(t, [acct("1000", "2", "Cash renamed"), acct("1100", "11"), acct("2000", "2"), acct("9000", null)], D2));
  const now = (await md.questions.getAccount(t, "C", "1000", D2))!;
  assert.equal(now.accountId, a1000.accountId);
  assert.deepEqual([now.name, now.hierarchyNodeCode], ["Cash renamed", "2"]);
  assert.equal((await md.questions.getAccount(t, "C", "1000", D1))!.hierarchyNodeCode, "111");
  assert.deepEqual((await md.questions.accountsUnderNode(t, "C", "1", D2)).map((a) => a.accountNumber), ["1100"]);

  await assert.rejects(md.commands.applyAccounts(snap(t, [acct("3000", "NOPE")], D3)), ChangeSetInvalid);
  await assert.rejects(md.commands.applyHierarchy(snap(t, [node("1", "2"), node("2", "1")], D3)), /cycle/);
});

dbTest("batch lookups: entities, accounts and hierarchy paths", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("G"), legal("US1", "USD", "G")]));
  await md.commands.applyHierarchy(snap(t, [node("1", null), node("11", "1"), node("111", "11")]));
  await md.commands.applyAccounts(snap(t, [acct("1000", "111"), acct("2000", null)]));
  assert.deepEqual((await md.questions.getEntities(t, ["US1", "NOPE", "G"], D1)).map((e) => e.code).sort(), ["G", "US1"]);
  assert.deepEqual(await md.questions.getEntities(t, [], D1), []);
  assert.deepEqual((await md.questions.getAccounts(t, [{ chartCode: "C", accountNumber: "1000" }, { chartCode: "C", accountNumber: "2000" }, { chartCode: "C", accountNumber: "9" }, { chartCode: "X", accountNumber: "1000" }], D1)).map((a) => a.accountNumber).sort(), ["1000", "2000"]);
  assert.deepEqual(await md.questions.hierarchyPaths(t, "C", ["111", "1", "nope"], D1), [{ nodeCode: "111", path: ["111", "11", "1"] }, { nodeCode: "1", path: ["1"] }]);
  assert.deepEqual(await md.questions.hierarchyPaths(t, "C", ["111"], asOfDate("2025-01-01")), []);
  const other = newTenant();
  assert.deepEqual(await md.questions.getEntities(other, ["US1"], D1), []);
  assert.deepEqual(await md.questions.hierarchyPaths(other, "C", ["111"], D1), []);
});

dbTest("tenant isolation: the same codes in two tenants never mix", async () => {
  const a = newTenant();
  const b = newTenant();
  await md.commands.applyEntities(snap(a, [legal("X", "USD")]));
  await md.commands.applyEntities(snap(b, [legal("X", "JPY")]));
  await md.commands.applyHierarchy(snap(a, [node("1", null)]));
  await md.commands.applyAccounts(snap(a, [acct("1000", "1")]));
  assert.equal((await md.questions.getEntity(a, "X", D1))?.functionalCurrency, "USD");
  assert.equal((await md.questions.getEntity(b, "X", D1))?.functionalCurrency, "JPY");
  const ea = (await md.questions.getEntity(a, "X", D1))!.entityId;
  assert.deepEqual(await md.questions.functionalCurrencies(b, [ea], D1), [], "another tenant's entity id is unknown");
  assert.equal(await md.questions.getAccount(b, "C", "1000", D1), null);
  assert.deepEqual(await md.questions.accountsUnderNode(b, "C", "1", D1), []);
  assert.deepEqual(await events(b).then((e) => e.map((x) => x.kind)), ["ENTITY"]);
});

dbTest("the database itself refuses overlapping versions and duplicate codes", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("G")], D1));
  const e = (await md.questions.getEntity(t, "G", D1))!;
  const base = {
    tenant_id: t, valid_to: null, source_system: "erp", batch_id: randomUUID(), name: "dup", entity_type: "GROUP", parent_entity_id: null,
    country_code: null, functional_currency: null, is_legal_entity: false, is_treasury_entity: false, is_hedge_execution_entity: false,
  };
  await assert.rejects(q(db).insertInto("entities").values({ ...base, entity_id: e.entityId, valid_from: D2, code: "G" }).execute(), /exclusion|overlap|conflicting/i);
  await assert.rejects(q(db).insertInto("entities").values({ ...base, entity_id: randomUUID(), valid_from: D2, code: "G" }).execute(), /exclusion|overlap|conflicting/i, "same code, different id");
});

dbTest("two changes on the same day replace the version instead of overlapping it", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("G")], D1));
  await md.commands.applyEntities(part(t, [{ ...ent("G"), name: "first edit" }], D2));
  await md.commands.applyEntities(part(t, [{ ...ent("G"), name: "second edit" }], D2));
  assert.equal((await md.questions.getEntity(t, "G", D2))?.name, "second edit");
  assert.equal((await md.questions.getEntity(t, "G", D1))?.name, "Entity G");
  const rows = await q(db).selectFrom("entities").select("valid_from").where("tenant_id", "=", t).execute();
  assert.equal(rows.length, 2, "the original and one version for D2");
});

dbTest("a manual row is not ended by an ERP snapshot, and an unknown id is not an entity", async () => {
  const t = newTenant();
  await md.commands.applyEntities(snap(t, [ent("A")], D1));
  await md.commands.applyEntities(part(t, [ent("M")], D1));
  await md.commands.applyEntities(snap(t, [], D2)); // the ERP now lists nothing
  assert.equal(await md.questions.getEntity(t, "A", D2), null);
  assert.equal((await md.questions.getEntity(t, "M", D2))?.code, "M");
  assert.deepEqual(await md.questions.entityWalk(t, entityId(randomUUID()) as EntityId, "descendants", D2), []);
});

dbTest("the same change set arriving at the same moment is applied once", async () => {
  const t = newTenant();
  const rows = [ent("G"), ent("H")];
  const results = await Promise.all([1, 2, 3].map(() => md.commands.applyEntities(snap(t, rows, D1))));
  assert.deepEqual(results.map((r) => r.status).sort(), ["APPLIED", "DUPLICATE", "DUPLICATE"]);
  assert.equal((await events(t)).length, 1);
});

dbTest("currencies: the NDF flag is versioned; a lookup reads the day asked about; a change announces once", async () => {
  const t = newTenant();
  await md.commands.applyCurrencies(snap(t, [{ code: "BRL", isNdf: true }, { code: "EUR", isNdf: false }], D1));
  assert.deepEqual(await md.questions.getCurrencies(t, D1), [{ code: "BRL", isNdf: true }, { code: "EUR", isNdf: false }]);
  const r = await md.commands.applyCurrencies(snap(t, [{ code: "BRL", isNdf: false }, { code: "EUR", isNdf: false }], D2));
  assert.deepEqual([r.status, r.changed, r.unchanged], ["APPLIED", 1, 1]);
  assert.equal((await md.questions.getCurrencies(t, asOfDate("2026-02-01"))).find((c) => c.code === "BRL")?.isNdf, true, "still NDF before the change");
  assert.equal((await md.questions.getCurrencies(t, D2)).find((c) => c.code === "BRL")?.isNdf, false);
  assert.deepEqual(await md.questions.getCurrencies(newTenant(), D1), []);
  assert.equal((await events(t)).filter((e) => e.kind === "CURRENCY").length, 2);
  await assert.rejects(md.commands.applyCurrencies(part(t, [{ code: "xx", isNdf: true }], D3)), ChangeSetInvalid);
});

const cal = (currencyCode: string, over: Partial<{ weekendDays: ("SAT" | "SUN" | "FRI")[]; coveredThrough: string; holidays: { date: string; name: string | null }[] }> = {}) =>
  ({ currencyCode, weekendDays: ["SAT", "SUN"] as ("SAT" | "SUN" | "FRI")[], coveredThrough: "2026-12-31", holidays: [{ date: "2026-05-01", name: "Labour Day" }], ...over });

dbTest("calendars: a currency's weekend and holidays are versioned; a lookup reads the day asked about; order does not matter; a change announces once", async () => {
  const t = newTenant();
  const a = await md.commands.applyCalendars(snap(t, [cal("EUR", { holidays: [{ date: "2026-12-25", name: "Christmas" }, { date: "2026-05-01", name: null }] }), cal("SAR", { weekendDays: ["FRI", "SAT"] })], D1));
  assert.deepEqual([a.status, a.created], ["APPLIED", 2]);
  const got = await md.questions.getCalendars(t, ["EUR", "SAR", "JPY"], D1);
  assert.deepEqual(got.map((c) => c.currency), ["EUR", "SAR"], "a currency with no calendar is left out");
  assert.deepEqual(got[0]!.holidays, [{ date: "2026-05-01", name: null }, { date: "2026-12-25", name: "Christmas" }], "holidays come back by date");
  assert.deepEqual(got[1]!.weekendDays, ["FRI", "SAT"]);
  assert.equal(got[0]!.coveredThrough, "2026-12-31");
  assert.deepEqual(await md.questions.getCalendars(t, [], D1), []);

  // The same calendar sent again with its holidays in another order is no change; a new holiday and a longer cover is one.
  const same = await md.commands.applyCalendars(snap(t, [cal("EUR", { holidays: [{ date: "2026-05-01", name: null }, { date: "2026-12-25", name: "Christmas" }] }), cal("SAR", { weekendDays: ["SAT", "FRI"] })], D2));
  assert.deepEqual([same.changed, same.unchanged], [0, 2]);
  const next = await md.commands.applyCalendars(snap(t, [cal("EUR", { coveredThrough: "2027-12-31", holidays: [{ date: "2026-12-25", name: "Christmas" }, { date: "2027-01-01", name: "New Year" }] }), cal("SAR", { weekendDays: ["FRI", "SAT"] })], D3));
  assert.deepEqual([next.changed, next.unchanged], [1, 1]);
  assert.equal((await md.questions.getCalendars(t, ["EUR"], D2))[0]!.holidays.length, 2, "before the change the old list stood");
  assert.deepEqual((await md.questions.getCalendars(t, ["EUR"], D3))[0]!.holidays.map((h) => h.date), ["2026-12-25", "2027-01-01"]);
  assert.equal((await md.questions.getCalendars(newTenant(), ["EUR"], D1)).length, 0, "another tenant sees nothing");
  assert.equal((await events(t)).filter((e) => e.kind === "CALENDAR").length, 2, "the repeat announced nothing");
});

dbTest("calendars: a bad calendar is refused with every problem named", async () => {
  const t = newTenant();
  const bad = async (row: unknown) => {
    try { await md.commands.applyCalendars(part(t, [row as never], D1)); } catch (e) { assert.ok(e instanceof ChangeSetInvalid); return (e as ChangeSetInvalid).problems.join(" | "); }
    return "accepted";
  };
  assert.match(await bad({ ...cal("eur") }), /three capital letters/);
  assert.match(await bad({ ...cal("EUR"), weekendDays: ["SAT", "FUN"] }), /weekend days must be from/);
  assert.match(await bad({ ...cal("EUR"), weekendDays: ["SAT", "SAT"] }), /listed twice/);
  assert.match(await bad({ ...cal("EUR"), weekendDays: ["MON", "TUE", "WED", "THU"] }), /at most three/);
  assert.match(await bad({ ...cal("EUR"), coveredThrough: "2026-02-30" }), /covered-through must be a real date/);
  assert.match(await bad(cal("EUR", { holidays: [{ date: "2027-01-01", name: null }] })), /after the covered-through date/);
  assert.match(await bad(cal("EUR", { holidays: [{ date: "2026-05-01", name: null }, { date: "2026-05-01", name: null }] })), /listed twice/);
  assert.match(await bad(cal("EUR", { holidays: [{ date: "2026-13-01", name: null }] })), /real date/);
  assert.match(await bad(cal("EUR", { holidays: [{ date: "2026-05-01", name: " " }] })), /blank name/);
  assert.equal((await md.questions.getCalendars(t, ["EUR"], D1)).length, 0, "nothing was written");
});

const pairRow = (pair: string, exposureCurrency: string) => ({ pair, exposureCurrency });
const forProgram = <R>(s: ReturnType<typeof snap<R>> | ReturnType<typeof part<R>>, programCode: string, by = "test") => ({ ...s, programCode, by });
const pairs = async (t: TenantId, program: string, on = D1) => (await md.questions.getPairExposureCurrencies(t, programId(program), on)).map((m) => `${m.pair}:${m.exposureCurrency}`);
const recordsOf = async (t: TenantId) => (await md.outbox.pending(1000)).filter((e) => e.tenantId === t && e.type === "master-data.change-recorded") as unknown as { programId: string | null; action: string; fields: unknown[] }[];

dbTest("pair exposure currencies: kept per program and versioned; a pair written either way is one row; another program's mapping is not returned", async () => {
  const t = newTenant();
  const a = await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("GBP-EUR", "GBP"), pairRow("BRL-USD", "USD")], D1), "BS"));
  assert.deepEqual([a.status, a.created], ["APPLIED", 2]);
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "EUR")], D1), "CF"));
  assert.deepEqual(await pairs(t, "BS"), ["BRL-USD:USD", "EUR-GBP:GBP"], "stored alphabetical, by pair");
  assert.deepEqual(await pairs(t, "CF"), ["EUR-GBP:EUR"], "two programs can map the same pair differently");
  assert.deepEqual(await pairs(t, "NONE"), []);
  assert.deepEqual(await md.questions.getPairExposureCurrencies(newTenant(), programId("BS"), D1), [], "another tenant sees nothing");

  // Sent again with the pair written the other way round: no change. A real change is versioned from its date.
  const same = await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "GBP"), pairRow("USD-BRL", "USD")], D2), "BS"));
  assert.deepEqual([same.changed, same.unchanged, same.ended], [0, 2, 0]);
  const next = await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "EUR"), pairRow("BRL-USD", "USD")], D3), "BS"));
  assert.deepEqual([next.changed, next.unchanged], [1, 1]);
  assert.ok((await pairs(t, "BS", D2)).includes("EUR-GBP:GBP"), "before the change the old mapping stood");
  assert.ok((await pairs(t, "BS", D3)).includes("EUR-GBP:EUR"));
  assert.equal((await events(t)).filter((e) => e.kind === "EXPOSURE_CURRENCY").length, 3, "the repeat announced nothing");
});

dbTest("pair exposure currencies: programs sharing a source stay apart; a snapshot for one program never ends another's mappings, and both can send one on the same date", async () => {
  const t = newTenant();
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "EUR"), pairRow("BRL-USD", "USD")], D1), "BS"));
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "GBP"), pairRow("BRL-USD", "BRL"), pairRow("EUR-USD", "USD")], D1), "CF"));
  assert.deepEqual([await pairs(t, "BS"), await pairs(t, "CF")], [["BRL-USD:USD", "EUR-GBP:EUR"], ["BRL-USD:BRL", "EUR-GBP:GBP", "EUR-USD:USD"]], "same source, same date, both stored");

  // A later Balance Sheet snapshot that leaves one pair out ends only Balance Sheet's.
  const r = await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "EUR")], D2), "BS"));
  assert.deepEqual([r.status, r.ended], ["APPLIED", 1]);
  assert.deepEqual(await pairs(t, "BS", D2), ["EUR-GBP:EUR"]);
  assert.deepEqual(await pairs(t, "CF", D2), ["BRL-USD:BRL", "EUR-GBP:GBP", "EUR-USD:USD"], "Cash Flow is untouched");

  // An empty snapshot has a target: it ends that program's mappings and no one else's.
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [], D3), "BS"));
  assert.deepEqual(await pairs(t, "BS", D3), []);
  assert.equal((await pairs(t, "CF", D3)).length, 3);

  // The same program, source and date with different content is still refused; the same content is a duplicate.
  await assert.rejects(md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "GBP")], D3), "BS")), /already sent with different content/);
  assert.equal((await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [], D3), "BS"))).status, "DUPLICATE");

  // History checks are per program: Cash Flow's newer version does not block an older-dated Balance Sheet set, and vice versa it does block its own.
  const t2 = newTenant();
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t2, [pairRow("EUR-GBP", "EUR")], D3), "CF"));
  assert.equal((await md.commands.applyPairExposureCurrencies(forProgram(snap(t2, [pairRow("EUR-GBP", "EUR")], D1), "BS"))).status, "APPLIED");
  await assert.rejects(md.commands.applyPairExposureCurrencies(forProgram(snap(t2, [pairRow("EUR-GBP", "GBP")], D1), "CF")), /would rewrite history/);
});

dbTest("pair exposure currencies: the safeguard counts only the program's own open rows", async () => {
  const t = newTenant();
  const twelve = "ABCDEFGHIJKL".split("").map((c) => pairRow(`${c}${c}${c}-USD`, "USD"));
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, twelve, D1), "BS"));
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, twelve, D1), "CF"));
  // Ending 4 of Balance Sheet's 12 is a third of its rows, so it is held. Counted across both programs (4 of 24) it would have passed.
  const held = await md.commands.applyPairExposureCurrencies(forProgram(snap(t, twelve.slice(0, 8), D2), "BS"));
  assert.equal(held.status, "HELD");
  assert.match(held.heldReason!, /would end 4 of 12 open rows/);
  assert.deepEqual([(await pairs(t, "BS", D2)).length, (await pairs(t, "CF", D2)).length], [12, 12], "nothing moved while held");
  const rel = await md.commands.releaseChangeSet(t, held.batchId, "user:1");
  assert.deepEqual([rel.status, rel.ended], ["APPLIED", 4]);
  assert.deepEqual([(await pairs(t, "BS", D2)).length, (await pairs(t, "CF", D2)).length], [8, 12], "the release applied to the program it was sent for");
});

dbTest("pair exposure currencies: the change record names the program and carries no mapping values", async () => {
  const t = newTenant();
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "EUR")], D1), "BS", "user:1"));
  await md.commands.applyPairExposureCurrencies(forProgram(snap(t, [pairRow("EUR-GBP", "GBP")], D1), "CF", "user:1"));
  const rs = await recordsOf(t);
  assert.deepEqual(rs.map((r) => r.programId).sort(), ["BS", "CF"], "each record is in its own program, so a reviewer restricted to one sees only that one");
  assert.ok(rs.every((r) => r.action === "master-data.exposure_currency-changed" && r.fields.length === 0), "no mapping values in Audit");
});

dbTest("pair exposure currencies: a bad mapping is refused with every problem named", async () => {
  const t = newTenant();
  const bad = async (program: string, ...rows: unknown[]) => {
    try { await md.commands.applyPairExposureCurrencies({ ...part(t, rows as never[], D1), rows: rows as never[], programCode: program }); } catch (e) { assert.ok(e instanceof ChangeSetInvalid); return (e as ChangeSetInvalid).problems.join(" | "); }
    return "accepted";
  };
  assert.match(await bad("BS", pairRow("EURGBP", "EUR")), /two different currency codes/);
  assert.match(await bad("BS", pairRow("EUR-EUR", "EUR")), /two different currency codes/);
  assert.match(await bad("BS", pairRow("eur-GBP", "EUR")), /two different currency codes/);
  assert.match(await bad("BS", pairRow("EUR-GBP", "USD")), /must be one of the pair/);
  assert.match(await bad(" ", pairRow("EUR-GBP", "EUR")), /program code is required/);
  assert.match(await bad("BS", pairRow("EUR-GBP", "EUR"), pairRow("GBP-EUR", "GBP")), /appears twice/);
  assert.deepEqual(await pairs(t, "BS"), [], "nothing was written");
});
