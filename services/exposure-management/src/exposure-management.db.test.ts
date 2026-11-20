// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// exposure_management schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { asOfDate, cycleId, programId, tenantId, type CycleId, type TenantId } from "@shared/kernel";
import type { Actor, IdentityQuestions, Permission, PlatformUserId, UserId } from "@services/identity/contract";
import { migrate } from "../../../scripts/migrate.mjs";
import { AccessDenied, connect, createExposureManagement, CycleRefused, ProgramRefused, type Db, type NewProgram } from "./index.ts";
import { q } from "./db.ts";
import { lockTenantPolicy } from "./queries.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("exposure management database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

// A fake Identity: users hold permissions, programs are enabled per tenant, a platform actor may do anything.
const enabledPrograms = new Map<string, Set<string>>();
const grants = new Map<string, { permissions: Set<Permission>; programs: Set<string> | null }>();
const access: Pick<IdentityQuestions, "checkAccess" | "enabledPrograms"> = {
  async enabledPrograms(t) { return [...(enabledPrograms.get(t) ?? [])].map(programId); },
  async checkAccess({ tenantId: t, actor, permission, programId: p }) {
    if (p !== undefined && !(enabledPrograms.get(t) ?? new Set()).has(p)) return { allowed: false, reason: "program-not-enabled" };
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
// Hedge Recommendation as the handshake sees it: who has decided on a cycle, and the reservations in flight. `claim` is what a hedge decision does there.
const deciders = new Map<string, string[]>();
const holds = new Map<string, { key: string; approver: string }>();
const hooks: { beforeReserve?: () => Promise<void>; afterReserve?: () => Promise<void>; failRelease?: boolean } = {};
const decisions = {
  async reserveApproval(t: TenantId, c: CycleId, approver: string, reservationId: string) {
    await hooks.beforeReserve?.();
    const key = `${t}:${c}`;
    if ((deciders.get(key) ?? []).includes(approver)) return { held: false };
    holds.set(reservationId, { key, approver });
    await hooks.afterReserve?.();
    return { held: true };
  },
  async releaseApproval(_t: TenantId, reservationId: string) {
    if (hooks.failRelease) throw new Error("Hedge Recommendation unreachable");
    holds.delete(reservationId);
  },
};
const claim = (t: TenantId, c: string, who: string): boolean => {
  if ([...holds.values()].some((h) => h.key === `${t}:${c}` && h.approver === who)) return false; // refused: you are approving this cycle
  deciders.set(`${t}:${c}`, [...(deciders.get(`${t}:${c}`) ?? []), who]);
  return true;
};
const admin: Actor = { kind: "platform", platformUserId: "ops-1" as PlatformUserId };

let db: Db;
let em: ReturnType<typeof createExposureManagement>;
const clock = new Date("2026-03-10T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("exposure_management").ifExists().cascade().execute();
  await migrate(url!);
  em = createExposureManagement(db, { access, decisions, now: () => clock });
});
after(async () => {
  if (enabled) await db.destroy();
});

const D1 = asOfDate("2026-03-05");
const newTenant = (...programs: string[]) => {
  const t = tenantId(randomUUID());
  enabledPrograms.set(t, new Set(programs));
  return t;
};
const settings = { nettingLevel: "ENTITY", bucketScheme: { kind: "DAYS", boundaries: [0, 30, 90] } as const, schedule: null };
const define = (t: TenantId, id: string, over: Partial<NewProgram> = {}) =>
  em.commands.defineProgram({ tenantId: t, programId: id, name: `Program ${id}`, type: "BALANCE_SHEET", settings, effectiveFrom: "2026-01-01", actor: admin, ...over });
const everything = async (t: TenantId) => (await em.outbox.pending(1000)).filter((e) => e.tenantId === t);
const events = async (t: TenantId) => (await everything(t)).filter((e) => e.type !== "exposure-management.change-recorded"); // what other services react to
const changes = async (t: TenantId) => (await everything(t)).flatMap((e) => (e.type === "exposure-management.change-recorded" ? [`${e.action} ${e.targetType}`] : [])); // what Audit is told
const types = async (t: TenantId) => (await events(t)).map((e) => e.type.replace("exposure-management.", ""));
const runs = (t: TenantId, c: CycleId) => ({ tenantId: t, cycleId: c as string, runId: randomUUID() });

async function ready(...programs: string[]) {
  const t = newTenant(...programs);
  for (const p of programs) await define(t, p);
  return t;
}
const analyst = () => user(["cycle:read", "cycle:initiate"]);
const approver = () => user(["cycle:read", "cycle:initiate", "cycle:skip", "cycle:approve", "exposure:approve"]);
/** Start a cycle and take it through a run to completed. */
async function completed(t: TenantId, p = "BS", asOf = "2026-03-05") {
  const id = await em.commands.startCycle({ tenantId: t, programId: p, asOf, actor: analyst() });
  const run = runs(t, id);
  await em.commands.onRunStarted(run);
  await em.commands.onRunFinished(run);
  return { id, run };
}

dbTest("a program is defined only for a code Identity has enabled, by someone who may manage programs", async () => {
  const t = newTenant("BS");
  await assert.rejects(define(t, "NOPE"), /not enabled for this tenant/);
  await assert.rejects(define(t, "BS", { actor: user(["cycle:read"]) }), AccessDenied);
  await assert.rejects(define(t, "BS", { name: " " }), ProgramRefused);
  await assert.rejects(define(t, "BS", { settings: { ...settings, nettingLevel: "X" } }), /netting level/);
  await assert.rejects(define(t, "BS", { effectiveFrom: "2026-02-30" }), /not a date/);
  await define(t, "BS");
  await assert.rejects(define(t, "BS"), /already defined/);
  assert.deepEqual((await em.questions.programCatalog(t)).map((p) => [p.programId, p.name, p.type, p.enabled]), [["BS", "Program BS", "BALANCE_SHEET", true]]);
  assert.deepEqual(await types(t), ["program-changed"]);
});

dbTest("combination rules are enforced when programs are defined", async () => {
  const t = newTenant("BS", "BS2", "CF", "B2C");
  await define(t, "BS");
  await assert.rejects(define(t, "BS2"), /only one balance sheet/);
  await define(t, "CF", { type: "CASH_FLOW" });
  await assert.rejects(define(t, "B2C", { type: "BUDGET_TO_CASH" }), /Budget to Cash/);
  const t2 = newTenant("B2C", "CF");
  await define(t2, "B2C", { type: "BUDGET_TO_CASH" });
  await assert.rejects(define(t2, "CF", { type: "CASH_FLOW" }), /Budget to Cash/);
});

dbTest("settings are versions: a lookup reads the one in force, and history is never rewritten", async () => {
  const t = await ready("BS");
  const mgr = user(["program:manage"]);
  const change = (effectiveFrom: string, nettingLevel = "GROUP_NATURAL", actor: Actor = mgr) =>
    em.commands.changeSettings({ tenantId: t, programId: "BS", settings: { ...settings, nettingLevel }, effectiveFrom, actor });
  await change("2026-02-01");
  const on = (d: string) => em.questions.programSettings(t, programId("BS"), asOfDate(d));
  assert.equal((await on("2026-01-31"))?.nettingLevel, "ENTITY");
  assert.equal((await on("2026-02-01"))?.nettingLevel, "GROUP_NATURAL");
  assert.equal((await on("2026-02-01"))?.validFrom, "2026-02-01");
  assert.equal(await on("2025-12-31"), null, "nothing before the first version");
  assert.equal((await on("2026-02-01"))?.type, "BALANCE_SHEET");
  await assert.rejects(change("2026-02-01", "REGION"), /must start after/, "not on or before the open version's start");
  await assert.rejects(change("2026-01-15", "REGION"), /must start after/);
  await assert.rejects(change("2026-03-01", "ENTITY", user(["cycle:read"])), AccessDenied);
  await assert.rejects(em.commands.changeSettings({ tenantId: t, programId: "ZZ", settings, effectiveFrom: "2026-03-01", actor: admin }), AccessDenied);
  const rows = await q(db).selectFrom("program_settings").select(["valid_from", "valid_to"]).where("tenant_id", "=", t).orderBy("valid_from").execute();
  assert.deepEqual(rows.map((r) => [r.valid_from, r.valid_to]), [["2026-01-01", "2026-02-01"], ["2026-02-01", null]]);
  assert.deepEqual(await types(t), ["program-changed", "program-changed"]);
});

dbTest("a cycle starts for an enabled program with settings in force, and keeps a copy of them", async () => {
  const t = await ready("BS");
  const a = analyst();
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: a });
  const c = (await em.questions.getCycle(t, id))!;
  assert.deepEqual([c.stage, c.outcome, c.rerunCount, c.approvedAt, c.programId, c.asOf], ["INITIATED", null, 0, null, "BS", "2026-03-05"]);
  assert.deepEqual([c.settings.nettingLevel, c.settings.bucketScheme], ["ENTITY", { kind: "DAYS", boundaries: [0, 30, 90] }]);
  assert.deepEqual(c.history.map((h) => h.kind), ["INITIATED"]);
  assert.match(c.initiatedBy, /^user:/);
  // later settings changes do not touch the copy
  await em.commands.changeSettings({ tenantId: t, programId: "BS", settings: { ...settings, nettingLevel: "REGION" }, effectiveFrom: "2026-03-06", actor: admin });
  assert.equal((await em.questions.getCycle(t, id))!.settings.nettingLevel, "ENTITY");
  const e = (await events(t)).find((x) => x.type === "exposure-management.cycle-initiated")!;
  assert.deepEqual(Object.keys(e).sort(), ["asOf", "cycleId", "eventId", "occurredAt", "programId", "tenantId", "type"]);
});

dbTest("starting a cycle is refused when it should be", async () => {
  const t = await ready("BS");
  const start = (over: object = {}) => em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst(), ...over } as never);
  await assert.rejects(start({ actor: user(["cycle:read"]) }), AccessDenied);
  await assert.rejects(start({ actor: user(["cycle:initiate"], ["OTHER"]) }), (e: unknown) => e instanceof AccessDenied && e.reason === "program-restricted");
  await assert.rejects(start({ asOf: "2026-03-11" }), /in the future/);
  await assert.rejects(start({ asOf: "2025-12-31" }), /no settings in force/);
  await assert.rejects(start({ asOf: "03/05/2026" }), CycleRefused);
  await assert.rejects(start({ programId: "ZZ" }), AccessDenied, "a program that is not enabled");
  await em.commands.onProgramDisabled({ tenantId: t, programId: programId("BS") });
  enabledPrograms.get(t)!.delete("BS"); // Identity disabled it
  await assert.rejects(start(), AccessDenied);
  assert.deepEqual((await em.questions.programCatalog(t)).map((p) => p.enabled), [false]);
  enabledPrograms.get(t)!.add("BS"); // Identity says enabled again but the event has not arrived
  await assert.rejects(start(), /is disabled/);
  assert.equal(await em.commands.onProgramEnabled({ tenantId: t, programId: programId("BS") }), true);
  assert.equal(await em.commands.onProgramEnabled({ tenantId: t, programId: programId("BS") }), false, "repeating an event changes nothing");
  assert.equal(await em.commands.onProgramDisabled({ tenantId: t, programId: programId("UNKNOWN") }), false);
  await start();
  await assert.rejects(start({ asOf: "2026-03-04" }), /already has an open cycle/);
});

dbTest("stages follow Exposure Analysis's events, and a late event from a replaced run counts for nothing", async () => {
  const t = await ready("BS");
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  const first = runs(t, id);
  assert.equal(await em.commands.onRunFinished(first), false, "finished before started: ignored");
  assert.equal(await em.commands.onRunStarted(first), true);
  assert.equal(await em.commands.onRunStarted(first), false, "a repeat");
  assert.equal((await em.questions.getCycle(t, id))!.stage, "IN_PROGRESS");
  assert.equal(await em.commands.onRunFinished({ ...first, runId: randomUUID() }), false, "another run's finish");
  assert.equal(await em.commands.onRunFinished(first), true);
  assert.equal(await em.commands.onRunFinished(first), false, "a repeat");
  assert.equal((await em.questions.getCycle(t, id))!.stage, "COMPLETED");
  assert.deepEqual(await types(t), ["program-changed", "cycle-initiated", "cycle-completed"]);

  // a rerun replaces the run: the old run's finish must not complete the new one
  await em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: analyst() });
  assert.equal(await em.commands.onRunFinished(first), false);
  const second = runs(t, id);
  await em.commands.onRunStarted(second);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: analyst() }), /in progress/);
  assert.equal(await em.commands.onRunFinished(first), false);
  assert.equal(await em.commands.onRunFinished(second), true);
  const c = (await em.questions.getCycle(t, id))!;
  assert.deepEqual([c.stage, c.rerunCount], ["COMPLETED", 1]);
  assert.deepEqual(c.history.map((h) => h.kind), ["INITIATED", "RUN_STARTED", "RUN_FINISHED", "RERUN", "RUN_STARTED", "RUN_FINISHED"]);
  assert.equal(await em.commands.onRunStarted({ tenantId: t, cycleId: randomUUID(), runId: "x" }), false, "an unknown cycle is ignored");
  assert.equal(await em.commands.onRunStarted({ ...second, tenantId: tenantId(randomUUID()) }), false, "another tenant's cycle is ignored");
});

dbTest("a cycle with no data can be rerun from initiated, and rerun announces the cycle again", async () => {
  const t = await ready("BS");
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  await em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: analyst() });
  assert.equal((await em.questions.getCycle(t, id))!.rerunCount, 1);
  assert.deepEqual(await types(t), ["program-changed", "cycle-initiated", "cycle-initiated"]);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: user(["cycle:read"]) }), AccessDenied);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: cycleId(randomUUID()), actor: analyst() }), /not found/);
});

dbTest("approval: only a completed cycle, only with the approve permission, and then it never changes", async () => {
  const t = await ready("BS");
  const { id } = await completed(t);
  const ap = approver();
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: analyst() }), AccessDenied);
  const notDone = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-04", actor: analyst() }).catch((e: Error) => e);
  assert.match(String(notDone), /open cycle/, "the completed cycle still blocks a new one until it is approved");
  // Approve Exposure is its own gate, before the cycle's: it locks the completed run and ends recalculation.
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: ap }), /approve the exposure before approving the cycle/);
  await assert.rejects(em.commands.approveExposure({ tenantId: t, cycleId: id, actor: analyst() }), AccessDenied);
  await em.commands.approveExposure({ tenantId: t, cycleId: id, actor: ap });
  const locked = (await em.questions.getCycle(t, id))!;
  assert.ok(locked.exposureApprovedAt && locked.exposureApprovedRunId && locked.exposureApprovedBy === `user:${(ap as { userId: string }).userId}`);
  assert.equal(locked.approvedAt, null, "the cycle itself is not approved yet");
  assert.deepEqual([locked.history.at(-1)?.kind, (await events(t)).at(-1)?.type], ["EXPOSURE_APPROVED", "exposure-management.exposure-approved"]);
  assert.equal(((await events(t)).at(-1) as { runId?: string }).runId, locked.exposureApprovedRunId, "the event names the locked run");
  await assert.rejects(em.commands.approveExposure({ tenantId: t, cycleId: id, actor: ap }), /already approved/);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: ap }), /exposure is approved, so it cannot be recalculated/);
  await em.commands.approveCycle({ tenantId: t, cycleId: id, actor: ap });
  const c = (await em.questions.getCycle(t, id))!;
  assert.equal(c.approvedBy, `user:${(ap as { userId: string }).userId}`);
  assert.ok(c.approvedAt);
  assert.equal(c.history.at(-1)?.kind, "APPROVED");
  assert.deepEqual((await events(t)).at(-1)?.type, "exposure-management.cycle-approved");
  assert.deepEqual((await changes(t)).filter((c) => c.endsWith(" cycle")), ["cycle.started cycle", "exposure.approved cycle", "cycle.approved cycle"], "the gates are recorded once each; refusals record nothing");
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: ap }), /already approved/);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: ap }), /approved cycle cannot be rerun/);
  await assert.rejects(em.commands.skipCycle({ tenantId: t, cycleId: id, reason: "x", actor: ap }), /approved cycle/);
  assert.equal(await em.commands.onRunStarted(runs(t, id)), false);
  const next = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-06", actor: analyst() });
  assert.notEqual(next, id, "an approved cycle no longer blocks the program");

  const t2 = await ready("BS");
  const fresh = await em.commands.startCycle({ tenantId: t2, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  await assert.rejects(em.commands.approveCycle({ tenantId: t2, cycleId: fresh, actor: approver() }), /only a completed cycle/);
  await assert.rejects(em.commands.approveExposure({ tenantId: t2, cycleId: fresh, actor: approver() }), /once its run has completed/);
});

dbTest("skipping and deleting need a reason and the skip permission, keep the record, and free the program", async () => {
  const t = await ready("BS");
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  const ap = approver();
  await assert.rejects(em.commands.skipCycle({ tenantId: t, cycleId: id, reason: "no data", actor: analyst() }), AccessDenied);
  await assert.rejects(em.commands.skipCycle({ tenantId: t, cycleId: id, reason: "  ", actor: ap }), /reason is required/);
  await em.commands.skipCycle({ tenantId: t, cycleId: id, reason: "ERP feed down", actor: ap });
  const c = (await em.questions.getCycle(t, id))!;
  assert.deepEqual([c.outcome, c.outcomeReason, c.stage], ["SKIPPED", "ERP feed down", "INITIATED"]);
  assert.equal(c.history.at(-1)?.note, "ERP feed down");
  await assert.rejects(em.commands.deleteCycle({ tenantId: t, cycleId: id, reason: "again", actor: ap }), /already skipped/);
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: ap }), /was skipped/);
  await assert.rejects(em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: ap }), /was skipped/);
  assert.equal(await em.commands.onRunStarted(runs(t, id)), false, "a skipped cycle ignores run events");

  const again = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  await em.commands.deleteCycle({ tenantId: t, cycleId: again, reason: "wrong date", actor: ap });
  assert.equal((await em.questions.getCycle(t, again))!.outcome, "DELETED", "kept, not removed");
  assert.deepEqual((await em.questions.cycles(t, { open: true })), []);
  assert.equal((await em.questions.cycles(t, { open: false })).length, 2);
  assert.deepEqual((await types(t)).filter((x) => x.startsWith("cycle-s") || x.startsWith("cycle-d")), ["cycle-skipped", "cycle-deleted"]);
});

dbTest("due cycles follow the schedule and skip what already exists", async () => {
  const t = newTenant("BS", "CF", "OFF");
  await define(t, "BS", { settings: { ...settings, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } } });
  await define(t, "CF", { type: "CASH_FLOW", settings: { ...settings, schedule: { frequency: "WEEKLY", dayOfWeek: 1, asOfOffsetDays: 3 } } });
  await define(t, "OFF", { type: "IN_HOUSE_BANK", settings: { ...settings, schedule: { frequency: "DAILY", asOfOffsetDays: 0 } } });
  await em.commands.onProgramDisabled({ tenantId: t, programId: programId("OFF") });
  const due = async (d: string) => (await em.questions.dueCycles(t, asOfDate(d))).map((x) => `${x.programId}:${x.asOf}`);
  assert.deepEqual(await due("2026-03-02"), ["BS:2026-03-01", "CF:2026-02-27"], "a Monday; the disabled program is left out");
  assert.deepEqual(await due("2026-03-03"), ["BS:2026-03-02"]);
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-01", actor: analyst() });
  assert.deepEqual(await due("2026-03-02"), ["CF:2026-02-27"], "its cycle exists");
  assert.deepEqual(await due("2026-03-03"), [], "an open cycle blocks the program");
  await em.commands.skipCycle({ tenantId: t, cycleId: id, reason: "skip", actor: approver() });
  assert.deepEqual(await due("2026-03-02"), ["CF:2026-02-27"], "a skipped cycle is not started again");
  assert.deepEqual(await due("2026-03-03"), ["BS:2026-03-02"]);
});

dbTest("tenant isolation", async () => {
  const a = await ready("BS");
  const b = await ready("BS");
  const { id } = await completed(a);
  assert.equal(await em.questions.getCycle(b, id), null);
  assert.deepEqual(await em.questions.cycles(b), []);
  await assert.rejects(em.commands.approveCycle({ tenantId: b, cycleId: id, actor: approver() }), /not found/);
  assert.equal((await em.questions.programCatalog(b)).length, 1);
  assert.equal(await em.questions.programSettings(b, programId("BS"), D1).then((s) => s?.programId), "BS");
});

dbTest("two starts at the same moment make one cycle", async () => {
  const t = await ready("BS");
  const results = await Promise.allSettled([1, 2, 3].map(() => em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && /open cycle/.test(String((r as PromiseRejectedResult).reason))).length, 2);
  assert.equal((await em.questions.cycles(t)).length, 1);
});

dbTest("the database itself refuses a second open cycle and an approved cycle that is not completed", async () => {
  const t = await ready("BS");
  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: analyst() });
  const row = { tenant_id: t, program_id: "BS", as_of: "2026-03-04", stage: "INITIATED" as const, outcome: null, outcome_reason: null, settings: "{}", current_run_id: null, approved_at: null, approved_by: null, initiated_by: "x" };
  await assert.rejects(q(db).insertInto("cycles").values({ ...row, cycle_id: randomUUID() }).execute(), /unique|duplicate/i);
  await assert.rejects(q(db).updateTable("cycles").set({ approved_at: new Date(), approved_by: "x" }).where("tenant_id", "=", t).where("cycle_id", "=", id).execute(), /check/i);
  await assert.rejects(q(db).updateTable("cycles").set({ outcome: "SKIPPED" }).where("tenant_id", "=", t).where("cycle_id", "=", id).execute(), /check/i, "an outcome needs a reason");
  await assert.rejects(q(db).updateTable("program_settings").set({ valid_to: "2025-01-01" }).where("tenant_id", "=", t).execute(), /check/i);
});

dbTest("display currency defaults to USD and earlier netting names are stored as the level they map to", async () => {
  const t = newTenant("BS");
  await define(t, "BS");
  assert.deepEqual(await em.questions.programSettings(t, programId("BS"), asOfDate("2026-02-01")).then((s) => [s?.nettingLevel, s?.displayCurrency]), ["ENTITY", "USD"]);
  await em.commands.changeSettings({ tenantId: t, programId: "BS", settings: { ...settings, nettingLevel: "CORPORATE_PAIR", displayCurrency: "EUR" }, effectiveFrom: "2026-02-01", actor: admin });
  assert.deepEqual(await em.questions.programSettings(t, programId("BS"), asOfDate("2026-02-01")).then((s) => [s?.nettingLevel, s?.displayCurrency]), ["GROUP_NATURAL", "EUR"]);
});

dbTest("exposure currency overrides are saved with the settings, default to none, and are copied into the cycle", async () => {
  const t = newTenant("BS");
  await define(t, "BS");
  assert.deepEqual((await em.questions.programSettings(t, programId("BS"), asOfDate("2026-02-01")))?.exposureCurrencyOverrides, []);
  await em.commands.changeSettings({ tenantId: t, programId: "BS", settings: { ...settings, exposureCurrencyOverrides: [{ pair: "EUR-GBP", exposureCurrency: "EUR" }] }, effectiveFrom: "2026-02-01", actor: admin });
  assert.deepEqual((await em.questions.programSettings(t, programId("BS"), asOfDate("2026-02-01")))?.exposureCurrencyOverrides, [{ pair: "EUR-GBP", exposureCurrency: "EUR" }]);
  await assert.rejects(em.commands.changeSettings({ tenantId: t, programId: "BS", settings: { ...settings, exposureCurrencyOverrides: [{ pair: "EUR-GBP", exposureCurrency: "JPY" }] }, effectiveFrom: "2026-03-01", actor: admin }), ProgramRefused);
});

dbTest("segregation of duties: on by default; the starter or rerunner cannot approve the exposure, a decider cannot approve the cycle, anyone else can; only a tenant admin switches it", async () => {
  const t = await ready("BS");
  const label = (a: Actor) => `user:${(a as { userId: string }).userId}`;
  assert.deepEqual(await em.questions.tenantSettings(t), { segregationOfDuties: true }, "on until switched off");
  const both = user(["cycle:read", "cycle:initiate", "exposure:approve", "cycle:approve"]); // starts and could approve
  const other = approver();

  const id = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: both });
  const run1 = runs(t, id);
  await em.commands.onRunStarted(run1);
  await em.commands.onRunFinished(run1);
  await assert.rejects(em.commands.approveExposure({ tenantId: t, cycleId: id, actor: both }), /you started or reran this cycle, so someone else must approve its exposure/);
  assert.equal((await em.questions.getCycle(t, id))!.exposureApprovedAt, null);
  assert.deepEqual((await changes(t)).filter((c) => c.includes("refused")), ["exposure.approval-refused-by-segregation-of-duties cycle"], "a refusal is written to the audit trail");

  // A rerun counts too: someone who reran the cycle cannot approve it either.
  const rerunner = user(["cycle:read", "cycle:initiate", "exposure:approve"]);
  await em.commands.rerunCycle({ tenantId: t, cycleId: id, actor: rerunner });
  const run2 = runs(t, id);
  await em.commands.onRunStarted(run2);
  await em.commands.onRunFinished(run2);
  await assert.rejects(em.commands.approveExposure({ tenantId: t, cycleId: id, actor: rerunner }), /started or reran/);
  await em.commands.approveExposure({ tenantId: t, cycleId: id, actor: other });

  // The cycle: whoever accepted or overrode a hedge cannot approve it; dismissals are not in the list Hedge Recommendation gives.
  deciders.set(`${t}:${id}`, [label(both)]);
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: both }), /you accepted or overrode a hedge on this cycle, so someone else must approve the cycle/);
  assert.equal((await em.questions.getCycle(t, id))!.approvedAt, null);
  await em.commands.approveCycle({ tenantId: t, cycleId: id, actor: other });
  assert.equal((await em.questions.getCycle(t, id))!.approvedBy, label(other));

  // Another reason to refuse comes first and is not written up as a segregation refusal.
  const before = (await changes(t)).filter((c) => c.includes("refused")).length;
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: both }), /already approved/);
  assert.equal((await changes(t)).filter((c) => c.includes("refused")).length, before);

  // Only someone who may manage authorization switches it; switching off lets one person do everything; a repeat records nothing.
  await assert.rejects(em.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: other }), AccessDenied);
  const owner = user(["authorization:manage"]);
  assert.equal(await em.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: owner }), true);
  assert.equal(await em.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: owner }), false);
  assert.deepEqual((await changes(t)).filter((c) => c.startsWith("tenant.")), ["tenant.segregation-of-duties-set tenant-setting"]);
  const solo = user(["cycle:read", "cycle:initiate", "exposure:approve", "cycle:approve"]);
  const id2 = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-06", actor: solo });
  const run3 = runs(t, id2);
  await em.commands.onRunStarted(run3);
  await em.commands.onRunFinished(run3);
  deciders.set(`${t}:${id2}`, [label(solo)]);
  await em.commands.approveExposure({ tenantId: t, cycleId: id2, actor: solo });
  await em.commands.approveCycle({ tenantId: t, cycleId: id2, actor: solo });
  assert.ok((await em.questions.getCycle(t, id2))!.approvedAt);

  // One tenant's switch does not touch another's.
  const u = await ready("BS");
  assert.deepEqual(await em.questions.tenantSettings(u), { segregationOfDuties: true });
});

// --- Concurrency of segregation of duties (decision 0013): each interleaving is forced, not hoped for. ---

const label = (a: Actor) => `user:${(a as { userId: string }).userId}`;
/** Waits until at least `n` database sessions are blocked on a lock. */
async function waitForBlocked(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(db);
    if (r.rows[0]!.n >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`fewer than ${n} sessions blocked on a lock`);
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

dbTest("segregation: Approve Exposure judges who started or reran the cycle as it stands once it has the cycle, not as it stood when it began", async () => {
  const t = await ready("BS");
  const x = user(["cycle:read", "cycle:initiate", "exposure:approve"]);
  const { id } = await completed(t); // started by someone else; x is not in the history yet
  let approval!: Promise<ReturnType<typeof settle> extends Promise<infer R> ? R : never>;
  await db.transaction().execute(async (tx) => {
    await q(tx).selectFrom("cycles").select("cycle_id").where("tenant_id", "=", t).where("cycle_id", "=", id).forUpdate().execute(); // the cycle is busy
    approval = settle(em.commands.approveExposure({ tenantId: t, cycleId: id, actor: x }));
    await waitForBlocked(1);
    // While x waits for the cycle, x's rerun lands and its run completes.
    await q(tx).insertInto("cycle_history").values({ tenant_id: t, cycle_id: id, seq: 100, kind: "RERUN", by_who: label(x), note: "rerun" }).execute();
  });
  const r = await approval;
  assert.equal(r.ok, false, "a rerunner cannot approve the resulting exposure");
  assert.match(String((r as { e: Error }).e.message), /started or reran/);
  assert.equal((await em.questions.getCycle(t, id))!.exposureApprovedAt, null);
});

dbTest("segregation: an approval is serialized with a change of the tenant policy, in either order", async () => {
  const t = await ready("BS");
  const s = user(["cycle:read", "cycle:initiate", "exposure:approve", "cycle:approve", "authorization:manage"]); // starts, and could approve
  const first = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-05", actor: s });
  const r1 = runs(t, first); await em.commands.onRunStarted(r1); await em.commands.onRunFinished(r1);

  // Policy change first: it is on (the default), a change to off is in flight and not yet committed; the approval waits, then sees off.
  let a!: ReturnType<typeof settle>;
  await db.transaction().execute(async (tx) => {
    await lockTenantPolicy(tx, t, "exclusive");
    a = settle(em.commands.approveExposure({ tenantId: t, cycleId: first, actor: s }));
    await waitForBlocked(1);
    await q(tx).insertInto("tenant_settings").values({ tenant_id: t, segregation_of_duties: false, updated_by: "test", updated_at: clock }).execute();
  });
  assert.equal((await a).ok, true, "the approval used the policy as changed, which is off");
  await em.commands.approveCycle({ tenantId: t, cycleId: first, actor: s });

  // Approval first in line, policy change second: the change waits for the approval, which saw off.
  const second = await em.commands.startCycle({ tenantId: t, programId: "BS", asOf: "2026-03-06", actor: s });
  const r2 = runs(t, second); await em.commands.onRunStarted(r2); await em.commands.onRunFinished(r2);
  let b!: ReturnType<typeof settle>;
  await db.transaction().execute(async (tx) => {
    await lockTenantPolicy(tx, t, "exclusive");
    await q(tx).updateTable("tenant_settings").set({ segregation_of_duties: true }).where("tenant_id", "=", t).execute();
    b = settle(em.commands.approveExposure({ tenantId: t, cycleId: second, actor: s }));
    await waitForBlocked(1);
  });
  const rb = await b;
  assert.equal(rb.ok, false, "the approval used the policy as changed, which is on");
  assert.match(String((rb as { e: Error }).e.message), /started or reran/);
});

dbTest("segregation: each actual change of the tenant policy is recorded once, however many arrive together; no-ops leave nothing behind", async () => {
  const t = await ready("BS");
  const o1 = user(["authorization:manage"]); const o2 = user(["authorization:manage"]);
  const row = () => q(db).selectFrom("tenant_settings").selectAll().where("tenant_id", "=", t).executeTakeFirst();
  const recorded = async () => (await changes(t)).filter((c) => c.startsWith("tenant.")).length;

  // Switching on when it is already on by default changes nothing: no row, no record.
  assert.equal(await em.commands.setSegregationOfDuties({ tenantId: t, enabled: true, actor: o1 }), false);
  assert.equal(await row(), undefined);
  assert.equal(await recorded(), 0);

  // Identical changes arriving together from the implicit default: one wins, once.
  const together = async (enabled: boolean, actors: Actor[]) => {
    let all!: Promise<boolean[]>;
    await db.transaction().execute(async (tx) => {
      await lockTenantPolicy(tx, t, "exclusive");
      all = Promise.all(actors.map((actor) => em.commands.setSegregationOfDuties({ tenantId: t, enabled, actor })));
      await waitForBlocked(actors.length);
    });
    return all;
  };
  const off = await together(false, [o1, o2, o1, o2]);
  assert.equal(off.filter(Boolean).length, 1);
  assert.equal(await recorded(), 1);
  const after1 = await row();
  assert.equal(after1!.segregation_of_duties, false);

  // A no-op changes neither the row nor the trail.
  assert.equal(await em.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: o2 }), false);
  const after2 = await row();
  assert.deepEqual([after2!.updated_by, after2!.updated_at], [after1!.updated_by, after1!.updated_at]);
  assert.equal(await recorded(), 1);

  // Opposing changes arriving together: whatever order they take, every change that actually happened is recorded once, and the last one stands.
  const results = await together(true, [o1]).then(async (on) => [on[0]!, ...(await together(false, [o2]))]);
  assert.deepEqual(results, [true, true]);
  let opposing!: Promise<boolean[]>;
  await db.transaction().execute(async (tx) => {
    await lockTenantPolicy(tx, t, "exclusive");
    opposing = Promise.all([true, false, true, false].map((enabled, i) => em.commands.setSegregationOfDuties({ tenantId: t, enabled, actor: i % 2 ? o2 : o1 })));
    await waitForBlocked(4);
  });
  const done = await opposing;
  const transitions = done.filter(Boolean).length;
  assert.equal(await recorded(), 1 + 2 + transitions, "one record per actual change");
  assert.ok(transitions >= 1);
});

dbTest("segregation: Approve Cycle reserves itself first, so a decision and the approval cannot both be won by one person, in either order", async () => {
  const t = await ready("BS");
  const p = approver(); const q2 = approver();
  const reasons = (e: unknown) => String((e as Error).message);

  // The approval is first: while it is in flight, its approver's decision is refused and another person's is not; the approval then succeeds.
  const { id } = await completed(t);
  await em.commands.approveExposure({ tenantId: t, cycleId: id, actor: q2 });
  const mine: boolean[] = [];
  hooks.afterReserve = async () => { mine.push(claim(t, id, label(p)), claim(t, id, label(q2))); };
  try { await em.commands.approveCycle({ tenantId: t, cycleId: id, actor: p }); } finally { hooks.afterReserve = undefined; }
  assert.deepEqual(mine, [false, true], "the approver was refused, someone else was not");
  assert.equal((await em.questions.getCycle(t, id))!.approvedBy, label(p));
  assert.equal(holds.size, 0, "the reservation was released");

  // The decision is first: the reservation is refused, the refusal is audited, nothing is left reserved.
  const t2 = await ready("BS");
  const { id: id2 } = await completed(t2);
  await em.commands.approveExposure({ tenantId: t2, cycleId: id2, actor: q2 });
  assert.equal(claim(t2, id2, label(p)), true);
  await assert.rejects(em.commands.approveCycle({ tenantId: t2, cycleId: id2, actor: p }), /accepted or overrode/);
  assert.equal(holds.size, 0);
  assert.deepEqual((await changes(t2)).filter((c) => c.includes("refused")), ["cycle.approval-refused-by-segregation-of-duties cycle"]);
  assert.equal((await em.questions.getCycle(t2, id2))!.approvedAt, null);
  void reasons;
});

dbTest("segregation: a failed or repeated Approve Cycle leaves nothing reserved, and a release that fails does not hide the approval", async () => {
  const t = await ready("BS");
  const p = approver(); const other = approver();
  const { id } = await completed(t);
  await em.commands.approveExposure({ tenantId: t, cycleId: id, actor: other });

  // The approval fails after reserving (someone else approved in the meantime): the reservation is released and the error is the real reason.
  hooks.afterReserve = async () => { hooks.afterReserve = undefined; await em.commands.approveCycle({ tenantId: t, cycleId: id, actor: other }); };
  try { await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: p }), /already approved/); } finally { hooks.afterReserve = undefined; }
  assert.equal(holds.size, 0);
  assert.equal((await em.questions.getCycle(t, id))!.approvedBy, label(other));

  // Repeating an approval that already stands is refused for that reason, reserves nothing, and changes nothing.
  await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: p }), /already approved/);
  assert.equal(holds.size, 0);
  assert.equal((await changes(t)).filter((c) => c === "cycle.approved cycle").length, 1);

  // A release that fails: the approval still reports success; the reservation is left for Hedge Recommendation to clear when the cycle closes.
  const t2 = await ready("BS");
  const { id: id2 } = await completed(t2);
  await em.commands.approveExposure({ tenantId: t2, cycleId: id2, actor: other });
  hooks.failRelease = true;
  try { await em.commands.approveCycle({ tenantId: t2, cycleId: id2, actor: p }); } finally { hooks.failRelease = false; }
  assert.equal((await em.questions.getCycle(t2, id2))!.approvedBy, label(p));
  assert.equal(holds.size, 1);
  holds.clear();

  // If the policy is switched off while the approval is in flight, the approval is allowed.
  const t3 = await ready("BS");
  const { id: id3 } = await completed(t3);
  await em.commands.approveExposure({ tenantId: t3, cycleId: id3, actor: other });
  deciders.set(`${t3}:${id3}`, []);
  const owner = user(["authorization:manage"]);
  hooks.afterReserve = async () => { hooks.afterReserve = undefined; await em.commands.setSegregationOfDuties({ tenantId: t3, enabled: false, actor: owner }); };
  try { await em.commands.approveCycle({ tenantId: t3, cycleId: id3, actor: p }); } finally { hooks.afterReserve = undefined; }
  assert.ok((await em.questions.getCycle(t3, id3))!.approvedAt);
  assert.equal(holds.size, 0);
});

// --- Recovery of an interrupted Approve Cycle (decision 0013) ---
const attemptStates = async (t: TenantId, c: string) => (await q(db).selectFrom("approval_attempts").select("state").where("tenant_id", "=", t).where("cycle_id", "=", c).orderBy("started_at").execute()).map((r) => r.state);
const readyForCycleApproval = async () => {
  const t = await ready("BS");
  const other = approver();
  const { id } = await completed(t);
  await em.commands.approveExposure({ tenantId: t, cycleId: id, actor: other });
  return { t, id, other };
};

dbTest("recovery: an approval that stopped before committing strands its holder until recovered; recovery is authorized, audited once, repeatable, and lets the team carry on", async () => {
  const { t, id, other } = await readyForCycleApproval();
  const p = approver();
  hooks.afterReserve = async () => { throw new Error("process died"); };
  hooks.failRelease = true;
  try { await assert.rejects(em.commands.approveCycle({ tenantId: t, cycleId: id, actor: p }), /process died/); } finally { hooks.afterReserve = undefined; hooks.failRelease = false; }
  assert.equal(holds.size, 1, "the reservation was left behind");
  assert.deepEqual(await attemptStates(t, id), ["IN_FLIGHT"]);
  assert.equal(claim(t, id, label(p)), false, "its holder cannot win a hedge decision");

  // Switching the policy off does not free it; recovery does.
  await em.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: user(["authorization:manage"]) });
  assert.equal(claim(t, id, label(p)), false);
  await assert.rejects(em.commands.recoverApproval({ tenantId: t, cycleId: id, actor: user(["cycle:read", "cycle:initiate"]) }), AccessDenied);
  assert.equal(holds.size, 1, "a refused recovery changed nothing");
  assert.equal(await em.commands.recoverApproval({ tenantId: t, cycleId: id, actor: other }), 1);
  assert.equal(holds.size, 0);
  assert.deepEqual(await attemptStates(t, id), ["ABANDONED"]);
  assert.equal(claim(t, id, label(p)), true, "the holder can decide again on the same cycle");
  assert.deepEqual((await changes(t)).filter((c) => c.startsWith("cycle.approval-recovered")), ["cycle.approval-recovered cycle"]);

  // Repeating it finds nothing to stop and records nothing more; the cycle is still open and can be approved.
  assert.equal(await em.commands.recoverApproval({ tenantId: t, cycleId: id, actor: other }), 0);
  assert.equal((await changes(t)).filter((c) => c.startsWith("cycle.approval-recovered")).length, 1);
  await em.commands.approveCycle({ tenantId: t, cycleId: id, actor: other });
  assert.ok((await em.questions.getCycle(t, id))!.approvedAt);
});

dbTest("recovery: racing an active approval, in every order, the attempt either commits or can no longer commit, and nothing stays reserved", async () => {
  // Recovery lands after the attempt reserved and before it commits: the attempt cannot finish.
  let s = await readyForCycleApproval();
  const p = approver(); const r = approver();
  hooks.afterReserve = async () => { hooks.afterReserve = undefined; assert.equal(await em.commands.recoverApproval({ tenantId: s.t, cycleId: s.id, actor: r }), 1); };
  try { await assert.rejects(em.commands.approveCycle({ tenantId: s.t, cycleId: s.id, actor: p }), /stopped by a recovery/); } finally { hooks.afterReserve = undefined; }
  assert.equal((await em.questions.getCycle(s.t, s.id))!.approvedAt, null);
  assert.deepEqual(await attemptStates(s.t, s.id), ["ABANDONED"]);
  assert.equal(holds.size, 0);
  await em.commands.approveCycle({ tenantId: s.t, cycleId: s.id, actor: p }); // retrying is a new attempt, and it can commit
  assert.deepEqual(await attemptStates(s.t, s.id), ["ABANDONED", "COMMITTED"]);

  // Recovery lands before the attempt's reservation reaches Hedge Recommendation (a delayed attempt): it still cannot finish, and its late reservation is released.
  s = await readyForCycleApproval();
  hooks.beforeReserve = async () => { hooks.beforeReserve = undefined; assert.equal(await em.commands.recoverApproval({ tenantId: s.t, cycleId: s.id, actor: r }), 1); };
  try { await assert.rejects(em.commands.approveCycle({ tenantId: s.t, cycleId: s.id, actor: p }), /stopped by a recovery/); } finally { hooks.beforeReserve = undefined; }
  assert.equal(holds.size, 0);
  assert.equal((await em.questions.getCycle(s.t, s.id))!.approvedAt, null);

  // The approval commits first: recovery finds nothing to stop and leaves the approval alone.
  s = await readyForCycleApproval();
  await em.commands.approveCycle({ tenantId: s.t, cycleId: s.id, actor: p });
  assert.equal(await em.commands.recoverApproval({ tenantId: s.t, cycleId: s.id, actor: r }), 0);
  assert.deepEqual(await attemptStates(s.t, s.id), ["COMMITTED"]);
  assert.ok((await em.questions.getCycle(s.t, s.id))!.approvedAt);

  // Genuinely concurrent: whichever order the cycle lock gives, the outcome is consistent.
  let approved = 0; let stopped = 0;
  for (let i = 0; i < 6; i++) {
    s = await readyForCycleApproval();
    const [a] = await Promise.all([settle(em.commands.approveCycle({ tenantId: s.t, cycleId: s.id, actor: p })), em.commands.recoverApproval({ tenantId: s.t, cycleId: s.id, actor: r })]);
    const done = (await em.questions.getCycle(s.t, s.id))!.approvedAt !== null;
    const states = await attemptStates(s.t, s.id);
    assert.equal(a.ok, done, "the approval reports what happened");
    assert.equal(states.includes("COMMITTED"), done, "an attempt is COMMITTED exactly when the cycle was approved");
    assert.equal(holds.size, 0, "nothing stays reserved");
    done ? approved++ : stopped++;
  }
  assert.equal(approved + stopped, 6);
});
