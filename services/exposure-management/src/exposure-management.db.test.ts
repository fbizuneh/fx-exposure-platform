// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// exposure_management schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, cycleId, programId, tenantId, type CycleId, type TenantId } from "@shared/kernel";
import type { Actor, IdentityQuestions, Permission, PlatformUserId, UserId } from "@services/identity/contract";
import { migrate } from "../../../scripts/migrate.mjs";
import { AccessDenied, connect, createExposureManagement, CycleRefused, ProgramRefused, type Db, type NewProgram } from "./index.ts";
import { q } from "./db.ts";

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
// Who decided hedges on a cycle, as Hedge Recommendation would answer.
const deciders = new Map<string, string[]>();
const admin: Actor = { kind: "platform", platformUserId: "ops-1" as PlatformUserId };

let db: Db;
let em: ReturnType<typeof createExposureManagement>;
const clock = new Date("2026-03-10T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("exposure_management").ifExists().cascade().execute();
  await migrate(url!);
  em = createExposureManagement(db, { access, decisions: { deciders: async (t, c) => deciders.get(`${t}:${c}`) ?? [] }, now: () => clock });
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
