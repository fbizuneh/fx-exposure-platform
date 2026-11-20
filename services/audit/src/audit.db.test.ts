// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the audit schema.
// Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { programId, tenantId, type TenantId } from "@shared/kernel";
import type { Actor, IdentityQuestions, Permission, UserId } from "@services/identity/contract";
import type { ChangeRecordedEvent } from "../contract/index.ts";
import { migrate } from "../../../scripts/migrate.mjs";
import { AccessDenied, connect, createAudit, RecordInvalid, type Db } from "./index.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("audit database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

// A fake Identity: a user may read the trail only with audit:read, in the programs they are given.
const grants = new Map<string, { permissions: Set<Permission>; programs: Set<string> | null }>();
const access: Pick<IdentityQuestions, "checkAccess" | "programScope"> = {
  async programScope(_t, actor) {
    if (actor.kind === "platform") return { restricted: false, programs: [] };
    const g = grants.get(actor.userId);
    return g?.programs ? { restricted: true, programs: [...g.programs].map(programId) } : { restricted: false, programs: [] };
  },
  async checkAccess({ actor, permission, programId: p }) {
    if (actor.kind === "platform") return { allowed: true, via: "platform-role" };
    const g = grants.get(actor.userId);
    if (!g) return { allowed: false, reason: "no-user" };
    if (!g.permissions.has(permission)) return { allowed: false, reason: "permission-missing" };
    if (p !== undefined && g.programs !== null && !g.programs.has(p)) return { allowed: false, reason: "program-restricted" };
    return { allowed: true, via: "user" };
  },
};
const user = (permissions: Permission[], programs: string[] | null = null): Actor => {
  const id = randomUUID() as UserId;
  grants.set(id, { permissions: new Set(permissions), programs: programs === null ? null : new Set(programs) });
  return { kind: "user", userId: id };
};
const reader = () => user(["audit:read"]);

let db: Db;
let raw: pg.Client;
let audit: ReturnType<typeof createAudit>;
let tick = 0;
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("audit").ifExists().cascade().execute();
  await migrate(url!);
  raw = new pg.Client({ connectionString: url });
  await raw.connect();
  audit = createAudit(db, { access }, { now: () => new Date("2026-03-10T12:00:00Z") });
});
after(async () => {
  if (!enabled) return;
  await raw.end();
  await db.destroy();
});

const newTenant = () => tenantId(randomUUID());
const change = (t: TenantId, over: Partial<ChangeRecordedEvent> = {}): ChangeRecordedEvent => ({
  type: "exposure-management.change-recorded", eventId: randomUUID(), occurredAt: new Date(Date.UTC(2026, 2, 10, 9, 0, tick++)).toISOString(),
  tenantId: t, programId: programId("BS"), actor: "user:alice", action: "cycle.approved", targetType: "cycle", targetId: "c1", fields: [], ...over,
});

dbTest("records join a tenant's trail in order, each linked to the one before, and each tenant has its own chain", async () => {
  const a = newTenant(), b = newTenant();
  for (const action of ["cycle.started", "cycle.approved"]) assert.equal(await audit.commands.record(change(a, { action })), "RECORDED");
  assert.equal(await audit.commands.record(change(b, { action: "program.defined", programId: null, fields: ["name", "settings"] })), "RECORDED");
  const who = reader();
  const ta = await audit.questions.trail({ tenantId: a, actor: who });
  assert.deepEqual(ta.records.map((r) => [r.seq, r.action, r.source]), [[1, "cycle.started", "exposure-management"], [2, "cycle.approved", "exposure-management"]]);
  assert.equal(ta.nextAfterSeq, null);
  const tb = await audit.questions.trail({ tenantId: b, actor: who });
  assert.deepEqual(tb.records.map((r) => [r.seq, r.programId, r.fields]), [[1, null, ["name", "settings"]]], "another tenant's trail starts at 1 and holds only its own");
  assert.notEqual(ta.records[0]!.hash, tb.records[0]!.hash);
  assert.deepEqual(await audit.questions.verify(a, who), { ok: true, checked: 2, brokenAtSeq: null });
});

dbTest("the same record twice changes nothing; a bad record is refused and leaves the trail alone", async () => {
  const t = newTenant();
  const e = change(t);
  assert.equal(await audit.commands.record(e), "RECORDED");
  assert.equal(await audit.commands.record(e), "DUPLICATE");
  assert.equal((await audit.questions.trail({ tenantId: t, actor: reader() })).records.length, 1);
  for (const bad of [{ actor: "" }, { action: " " }, { targetId: "" }, { fields: "x" as never }, { occurredAt: "yesterday" }, { type: "exposure-management.cycle-approved" as never }]) {
    await assert.rejects(audit.commands.record(change(t, bad)), RecordInvalid, JSON.stringify(bad));
  }
  assert.equal((await audit.questions.trail({ tenantId: t, actor: reader() })).records.length, 1);
});

dbTest("records arriving together get distinct, unbroken positions", async () => {
  const t = newTenant();
  await Promise.all(Array.from({ length: 12 }, (_, i) => audit.commands.record(change(t, { targetId: `c${i}` }))));
  const who = reader();
  assert.deepEqual((await audit.questions.trail({ tenantId: t, actor: who })).records.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal((await audit.questions.verify(t, who)).ok, true);
});

dbTest("the trail is append-only in the database: update, delete and truncate are refused", async () => {
  const t = newTenant();
  await audit.commands.record(change(t));
  await assert.rejects(raw.query("UPDATE audit.records SET actor = 'user:mallory' WHERE tenant_id = $1", [t]), /append-only/);
  await assert.rejects(raw.query("DELETE FROM audit.records WHERE tenant_id = $1", [t]), /append-only/);
  await assert.rejects(raw.query("TRUNCATE audit.records"), /append-only/);
  assert.equal((await audit.questions.trail({ tenantId: t, actor: reader() })).records[0]!.actor, "user:alice");
});

dbTest("verify finds an edited record, a removed record and a record cut off the end", async () => {
  const who = reader();
  // These tamper with the table by switching the trigger off, as someone with more access than this service has could.
  const tamper = async (sql: string, params: unknown[]) => {
    await raw.query("BEGIN");
    await raw.query("SET LOCAL session_replication_role = replica");
    await raw.query(sql, params);
    await raw.query("COMMIT");
  };
  const fill = async () => { const t = newTenant(); for (let i = 0; i < 4; i++) await audit.commands.record(change(t, { targetId: `c${i}` })); return t; };

  const edited = await fill();
  await tamper("UPDATE audit.records SET actor = 'user:mallory' WHERE tenant_id = $1 AND seq = 2", [edited]);
  assert.deepEqual(await audit.questions.verify(edited, who), { ok: false, checked: 1, brokenAtSeq: 2 });

  const removed = await fill();
  await tamper("DELETE FROM audit.records WHERE tenant_id = $1 AND seq = 2", [removed]);
  assert.deepEqual(await audit.questions.verify(removed, who), { ok: false, checked: 1, brokenAtSeq: 2 });

  const cut = await fill();
  await tamper("DELETE FROM audit.records WHERE tenant_id = $1 AND seq = 4", [cut]);
  assert.deepEqual(await audit.questions.verify(cut, who), { ok: false, checked: 3, brokenAtSeq: 4 });

  const relinked = await fill();
  await tamper("UPDATE audit.records SET prev_hash = 'GENESIS' WHERE tenant_id = $1 AND seq = 3", [relinked]);
  assert.equal((await audit.questions.verify(relinked, who)).brokenAtSeq, 3);

  // The time Audit received a record is protected like the rest, not only the time the change happened.
  const retimed = await fill();
  await tamper("UPDATE audit.records SET recorded_at = recorded_at + interval '1 second' WHERE tenant_id = $1 AND seq = 3", [retimed]);
  assert.deepEqual(await audit.questions.verify(retimed, who), { ok: false, checked: 2, brokenAtSeq: 3 });
  const reoccurred = await fill();
  await tamper("UPDATE audit.records SET occurred_at = occurred_at + interval '1 second' WHERE tenant_id = $1 AND seq = 2", [reoccurred]);
  assert.deepEqual(await audit.questions.verify(reoccurred, who), { ok: false, checked: 1, brokenAtSeq: 2 });
});

dbTest("reading needs audit:read, in the program when one is asked for; filters and paging work", async () => {
  const t = newTenant();
  const base = Date.UTC(2026, 2, 11, 9, 0, 0);
  const rows: Partial<ChangeRecordedEvent>[] = [
    { action: "cycle.started", programId: programId("BS"), actor: "user:alice", targetId: "c1", occurredAt: new Date(base).toISOString() },
    { action: "cycle.approved", programId: programId("BS"), actor: "user:bob", targetId: "c1", occurredAt: new Date(base + 60_000).toISOString() },
    { action: "program.defined", programId: programId("FC"), actor: "user:alice", targetType: "program", targetId: "FC", occurredAt: new Date(base + 120_000).toISOString() },
    { action: "user.added", programId: null, actor: "user:alice", targetType: "user", targetId: "u9", occurredAt: new Date(base + 180_000).toISOString() },
  ];
  for (const r of rows) await audit.commands.record(change(t, r));

  await assert.rejects(audit.questions.trail({ tenantId: t, actor: user(["fx-trade:read"]) }), AccessDenied);
  await assert.rejects(audit.questions.verify(t, user([])), AccessDenied);
  const onlyBs = user(["audit:read"], ["BS"]);
  assert.equal((await audit.questions.trail({ tenantId: t, actor: onlyBs, programId: programId("BS") })).records.length, 2);
  await assert.rejects(audit.questions.trail({ tenantId: t, actor: onlyBs, programId: programId("FC") }), /program-restricted/);

  const who = reader();
  const ids = async (extra: object) => (await audit.questions.trail({ tenantId: t, actor: who, ...extra })).records.map((r) => r.action);
  assert.deepEqual(await ids({ by: "user:alice" }), ["cycle.started", "program.defined", "user.added"]);
  assert.deepEqual(await ids({ action: "cycle.approved" }), ["cycle.approved"]);
  assert.deepEqual(await ids({ targetType: "cycle", targetId: "c1" }), ["cycle.started", "cycle.approved"]);
  assert.deepEqual(await ids({ programId: programId("FC") }), ["program.defined"]);
  assert.deepEqual(await ids({ from: new Date(base + 60_000).toISOString(), to: new Date(base + 120_000).toISOString() }), ["cycle.approved", "program.defined"]);
  const p1 = await audit.questions.trail({ tenantId: t, actor: who, limit: 3 });
  assert.deepEqual([p1.records.length, p1.nextAfterSeq], [3, 3]);
  const p2 = await audit.questions.trail({ tenantId: t, actor: who, limit: 3, afterSeq: p1.nextAfterSeq! });
  assert.deepEqual([p2.records.map((r) => r.action), p2.nextAfterSeq], [["user.added"], null]);
  assert.deepEqual((await audit.questions.trail({ tenantId: newTenant(), actor: who })).records, [], "another tenant's trail is empty");
});

dbTest("program scope applies to every read: a restricted reader's unfiltered trail holds only their programs' records, never tenant-wide ones, and cannot verify the chain", async () => {
  const t = newTenant();
  for (const r of [
    { action: "cycle.started", programId: programId("BS"), targetId: "c1" }, { action: "program.defined", programId: programId("FC"), targetType: "program", targetId: "FC" },
    { action: "user.added", programId: null, targetType: "user", targetId: "u1" }, { action: "cycle.approved", programId: programId("BS"), targetId: "c1" },
    { action: "cycle.started", programId: programId("FC"), targetId: "c9" }, { action: "role.granted", programId: null, targetType: "user-role", targetId: "u1/VIEWER" },
  ]) await audit.commands.record(change(t, r));
  const actions = async (actor: Actor, extra: object = {}) => (await audit.questions.trail({ tenantId: t, actor, ...extra })).records.map((r) => `${r.seq}:${r.action}:${r.programId ?? "-"}`);

  const open = user(["audit:read"]);
  assert.equal((await actions(open)).length, 6, "no program limit: the whole tenant trail, tenant-wide records included");
  assert.equal((await actions({ kind: "platform", platformUserId: "ops" as never })).length, 6);

  const bs = user(["audit:read"], ["BS"]);
  assert.deepEqual(await actions(bs), ["1:cycle.started:BS", "4:cycle.approved:BS"], "unfiltered: only BS; the FC records and the tenant-wide ones are not there");
  assert.deepEqual(await actions(bs, { programId: programId("BS") }), ["1:cycle.started:BS", "4:cycle.approved:BS"], "filtered to its own program: the same");
  await assert.rejects(audit.questions.trail({ tenantId: t, actor: bs, programId: programId("FC") }), /program-restricted/);
  assert.deepEqual(await actions(bs, { targetType: "user" }), [], "asking for tenant-wide records by target finds none");
  assert.deepEqual(await actions(bs, { by: "user:alice", limit: 1 }), ["1:cycle.started:BS"]);
  const page = await audit.questions.trail({ tenantId: t, actor: bs, limit: 1 });
  assert.equal(page.nextAfterSeq, 1, "paging counts only what the reader may see");

  const both = user(["audit:read"], ["BS", "FC"]);
  assert.deepEqual(await actions(both), ["1:cycle.started:BS", "2:program.defined:FC", "4:cycle.approved:BS", "5:cycle.started:FC"], "restricted to both programs is still not tenant-wide");

  await assert.rejects(audit.questions.verify(t, bs), /not allowed \(audit:read\): program-restricted/);
  await assert.rejects(audit.questions.verify(t, both), /program-restricted/);
  assert.equal((await audit.questions.verify(t, open)).ok, true);
});

dbTest("verifying while records are being appended never reports a false break", async () => {
  const t = newTenant();
  for (let i = 0; i < 5; i++) await audit.commands.record(change(t, { targetId: `seed${i}` }));
  const who = reader();
  let appending = true;
  const appender = (async () => { for (let i = 0; i < 60; i++) await audit.commands.record(change(t, { targetId: `live${i}` })); appending = false; })();
  const results = [];
  while (appending) results.push(await audit.questions.verify(t, who));
  await appender;
  results.push(await audit.questions.verify(t, who));
  assert.ok(results.length > 1, "verified more than once while the appends ran");
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.deepEqual(results.at(-1), { ok: true, checked: 65, brokenAtSeq: null });
});
