// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// master_data schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, entityId, tenantId, type EntityId, type TenantId } from "@shared/kernel";
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
const events = async (t: TenantId) => (await md.outbox.pending(1000)).filter((e) => e.tenantId === t);

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
