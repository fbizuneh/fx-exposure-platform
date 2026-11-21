// Database tests for the guarded stuck-event functions (decision 0030). Needs TEST_DATABASE_URL (name ends in _test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Actor } from "@services/identity/contract";
import type { TenantId } from "@shared/kernel";
import { migrate } from "../../scripts/migrate.mjs";
import { composeApp, type App } from "./compose.ts";
import { RETRY_POLICY, drain } from "./dispatch.ts";
import { AccessDenied, deliveryProblemSummary, listDeliveryProblems, retryDeliveryProblem } from "./operations.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("operations database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

let app: App;
let client: pg.Client;
before(async () => {
  if (!enabled) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"]) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await migrate(url!);
  app = composeApp(url!);
});
after(async () => {
  if (enabled) {
    await app.close();
    await client.end();
  }
});

/** A tenant with one person per role, plus a TREASURY_ADMIN to set things up. */
async function tenantWithRoles(): Promise<{ t: TenantId; admin: Actor; byRole: Record<string, Actor> }> {
  const t = await app.identity.commands.createTenant(`Acme-${randomUUID()}`);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const adminId = (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ADMIN"] }, ops)) as string;
  const admin: Actor = { kind: "user", userId: adminId as never };
  const byRole: Record<string, Actor> = {};
  for (const role of ["VIEWER", "TREASURY_ANALYST", "TREASURY_REVIEWER", "TREASURY_APPROVER"] as const) {
    const id = (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: [role] }, adminId)) as string;
    byRole[role] = { kind: "user", userId: id as never };
  }
  return { t, admin, byRole };
}

/** A raw fx-rate.loaded event in the named tenant's outbox, failed enough times to reach the given state. */
async function rawEvent(tenant: TenantId, failures: number): Promise<string> {
  const id = randomUUID();
  await client.query("INSERT INTO fx_rate.outbox (event_id, tenant_id, type, payload) VALUES ($1, $2, 'fx-rate.loaded', $3)", [id, tenant, JSON.stringify({ type: "fx-rate.loaded", tenantId: tenant, eventId: id, occurredAt: new Date().toISOString() })]);
  for (let i = 0; i < failures; i++) await app.fxRate.outbox.recordFailure(id, "rates unavailable", new Date(), RETRY_POLICY);
  return id;
}
const stuckEvent = (tenant: TenantId) => rawEvent(tenant, 5);
const waitingEvent = (tenant: TenantId) => rawEvent(tenant, 2);

const recordsOf = async (t: TenantId, admin: Actor) => (await app.audit.questions.trail({ tenantId: t, actor: admin, limit: 500 })).records;

dbTest("a viewer, analyst, reviewer and approver are refused; a tenant admin sees and retries only their own tenant", async () => {
  const a = await tenantWithRoles();
  const b = await tenantWithRoles();
  const stuckA = await stuckEvent(a.t);
  const stuckB = await stuckEvent(b.t);

  for (const role of ["VIEWER", "TREASURY_ANALYST", "TREASURY_REVIEWER", "TREASURY_APPROVER"]) {
    const who = a.byRole[role]!;
    await assert.rejects(listDeliveryProblems(app, who, { tenantId: a.t }), (e: unknown) => e instanceof AccessDenied && e.reason === "permission-missing");
    await assert.rejects(deliveryProblemSummary(app, who), AccessDenied);
    await assert.rejects(retryDeliveryProblem(app, who, { service: "fx-rate", tenantId: a.t, eventId: stuckA }), AccessDenied);
  }

  const seenByA = await listDeliveryProblems(app, a.admin, { tenantId: a.t });
  assert.deepEqual(seenByA.map((p) => p.eventId), [stuckA]);
  assert.deepEqual((await listDeliveryProblems(app, a.admin)).map((p) => p.eventId), [stuckA], "with no filter, the admin still sees only their own tenant");

  // the right event ID, but the wrong tenant named: looked up within the named tenant only, so it is not found
  await assert.rejects(retryDeliveryProblem(app, a.admin, { service: "fx-rate", tenantId: a.t, eventId: stuckB }), /no such event/);
  // b's admin cannot even ask about a's tenant
  await assert.rejects(retryDeliveryProblem(app, b.admin, { service: "fx-rate", tenantId: a.t, eventId: stuckA }), AccessDenied);

  await retryDeliveryProblem(app, a.admin, { service: "fx-rate", tenantId: a.t, eventId: stuckA });
  assert.deepEqual(await listDeliveryProblems(app, a.admin, { tenantId: a.t }), [], "retried: no longer a problem");
  assert.deepEqual((await listDeliveryProblems(app, b.admin, { tenantId: b.t })).map((p) => p.eventId), [stuckB], "b's event is untouched");
});

dbTest("a non-stuck event is refused, naming its state", async () => {
  const { t, admin } = await tenantWithRoles();
  const waiting = await waitingEvent(t);
  await assert.rejects(retryDeliveryProblem(app, admin, { service: "fx-rate", tenantId: t, eventId: waiting }), /retrying automatically; it is not stuck/);
  await assert.rejects(retryDeliveryProblem(app, admin, { service: "fx-rate", tenantId: t, eventId: randomUUID() }), /no such event/);
});

dbTest("a retried event is delivered on the next drain; retrying it again finds it already gone", async () => {
  const { t, admin } = await tenantWithRoles(); // a tenant of its own, so no earlier waiting event in this outbox holds it back
  const stuck = await stuckEvent(t);
  await retryDeliveryProblem(app, admin, { service: "fx-rate", tenantId: t, eventId: stuck });
  await assert.rejects(retryDeliveryProblem(app, admin, { service: "fx-rate", tenantId: t, eventId: stuck }), /not stuck|no such event/, "a second retry finds it already retrying or gone");
  await drain(app);
  const row = (await client.query("SELECT published_at FROM fx_rate.outbox WHERE event_id = $1", [stuck])).rows[0] as { published_at: Date | null };
  assert.ok(row.published_at !== null, "the retried event is delivered on the next drain");
});

dbTest("the platform role sees and retries every tenant, may filter by tenant, and its use is recorded", async () => {
  const a = await tenantWithRoles();
  const b = await tenantWithRoles();
  const stuckA = await stuckEvent(a.t);
  const stuckB = await stuckEvent(b.t);
  const mine = (ps: { tenantId: string; eventId: string }[]) => ps.filter((p) => p.tenantId === a.t || p.tenantId === b.t).map((p) => p.eventId).sort();
  const platformUserId = await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() });
  const platform: Actor = { kind: "platform", platformUserId: platformUserId as never };

  assert.deepEqual(mine(await listDeliveryProblems(app, platform)), [stuckA, stuckB].sort(), "every tenant, not only the platform user's own (it has none)");
  assert.deepEqual((await listDeliveryProblems(app, platform, { tenantId: a.t })).map((p) => p.eventId), [stuckA]);

  const summary = await deliveryProblemSummary(app, platform);
  assert.ok(summary.byService["fx-rate"]!.stuck >= 2, "counts at least this test's two stuck events, across whatever else is in the shared database");

  await retryDeliveryProblem(app, platform, { service: "fx-rate", tenantId: b.t, eventId: stuckB });
  assert.deepEqual(mine(await listDeliveryProblems(app, platform)), [stuckA]);

  await drain(app); // platform-role.used is announced through identity's own outbox, like any other change record
  const used = (await recordsOf(a.t, a.admin)).filter((r) => r.action === "platform-role.used");
  assert.ok(used.some((r) => r.targetId === "operations:manage-events"), "every use of the platform role is written to the trail (decision 0001)");
});

dbTest("an audit record exists for each retry: event.retried, the event ID as target, naming the service", async () => {
  const { t, admin } = await tenantWithRoles();
  const stuck = await stuckEvent(t);
  const before = (await recordsOf(t, admin)).length;
  await retryDeliveryProblem(app, admin, { service: "fx-rate", tenantId: t, eventId: stuck });
  const rs = await recordsOf(t, admin);
  assert.equal(rs.length, before + 1);
  const r = rs[rs.length - 1]!;
  assert.deepEqual([r.action, r.targetType, r.targetId, r.programId, r.fields], ["event.retried", "fx-rate", stuck, null, []]);
  assert.ok(r.actor.startsWith("user:"));
  assert.deepEqual(await app.audit.questions.verify(t, admin), { ok: true, checked: rs.length, brokenAtSeq: null });
});
