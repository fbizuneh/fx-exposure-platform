// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// identity schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { programId, type ProgramId, type TenantId } from "@shared/kernel";
import { migrate } from "../../../scripts/migrate.mjs";
import type { PlatformUserId, UserId } from "../contract/index.ts";
import { connect, createIdentity, type Db } from "./index.ts";
import { q } from "./db.ts";
import { announce } from "./outbox.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("identity database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

let db: Db;
let id: ReturnType<typeof createIdentity>;
const DAILY = programId("DAILY");
const MONTHLY = programId("MONTHLY");
const WEEKLY = programId("WEEKLY");

before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("identity").ifExists().cascade().execute();
  await migrate(url!);
  id = createIdentity(db);
});
after(async () => {
  if (enabled) await db.destroy();
});

async function tenantWith(name: string, programs: ProgramId[] = []) {
  const tenant = await id.commands.createTenant(name);
  const by = (await id.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  for (const p of programs) await id.commands.enableProgram(tenant, p, by);
  return { tenant, by };
}
const asUser = (tenant: TenantId, userId: UserId) => ({ tenantId: tenant, actor: { kind: "user", userId } }) as const;
const eventsFor = async (tenant: TenantId) => (await id.outbox.pending(1000)).filter((e) => e.tenantId === tenant);

dbTest("access end to end: roles, enabled programs, restriction, disabled user", async () => {
  const { tenant, by } = await tenantWith("Acme", [DAILY, MONTHLY]);
  const user = await id.commands.addUser(tenant, { issuer: "idp", externalSubject: "s1", roles: ["TREASURY_APPROVER"] }, by);
  const ask = (permission: "cycle:approve" | "authorization:manage", program?: ProgramId) =>
    id.questions.checkAccess({ ...asUser(tenant, user), permission, programId: program });

  assert.deepEqual(await ask("cycle:approve", DAILY), { allowed: true, via: "user" });
  assert.deepEqual(await ask("authorization:manage"), { allowed: false, reason: "permission-missing" });
  assert.deepEqual(await ask("cycle:approve", WEEKLY), { allowed: false, reason: "program-not-enabled" });

  await id.commands.setProgramRestriction(tenant, user, [MONTHLY]);
  assert.deepEqual(await ask("cycle:approve", DAILY), { allowed: false, reason: "program-restricted" });
  assert.deepEqual(await ask("cycle:approve", MONTHLY), { allowed: true, via: "user" });
  await id.commands.setProgramRestriction(tenant, user, null);
  assert.deepEqual(await ask("cycle:approve", DAILY), { allowed: true, via: "user" });

  await id.commands.grantRole(tenant, user, "TREASURY_ADMIN", by);
  await id.commands.grantRole(tenant, user, "TREASURY_ADMIN", by); // repeat changes nothing
  assert.deepEqual(await ask("authorization:manage"), { allowed: true, via: "user" });
  await id.commands.revokeRole(tenant, user, "TREASURY_ADMIN", by);
  assert.deepEqual(await ask("authorization:manage"), { allowed: false, reason: "permission-missing" });

  await id.commands.disableUser(tenant, user, by);
  assert.deepEqual(await ask("cycle:approve", DAILY), { allowed: false, reason: "user-disabled" });
  assert.deepEqual(await id.questions.checkAccess({ ...asUser(tenant, randomUUID() as UserId), permission: "cycle:read" }), { allowed: false, reason: "no-user" });
});

dbTest("platform users are allowed in any tenant; a disabled one is not", async () => {
  const { tenant } = await tenantWith("Platform test");
  const platformUserId = await id.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() });
  const query = { tenantId: tenant, actor: { kind: "platform", platformUserId } as const, permission: "authorization:manage" } as const;
  assert.deepEqual(await id.questions.checkAccess(query), { allowed: true, via: "platform-role" });
  await q(db).updateTable("platform_users").set({ status: "DISABLED" }).where("platform_user_id", "=", platformUserId as string).execute();
  assert.deepEqual(await id.questions.checkAccess(query), { allowed: false, reason: "no-user" });
});

dbTest("tenant isolation: one tenant never sees another's users or programs", async () => {
  const a = await tenantWith("Tenant A", [DAILY]);
  const b = await tenantWith("Tenant B");
  const ua = await id.commands.addUser(a.tenant, { issuer: "idp", externalSubject: "same", roles: ["TREASURY_ADMIN"] }, a.by);
  const ub = await id.commands.addUser(b.tenant, { issuer: "idp", externalSubject: "same", roles: ["TREASURY_ADMIN"] }, b.by);
  assert.notEqual(ua, ub, "the same person is a separate user in each tenant");

  assert.deepEqual(await id.questions.enabledPrograms(a.tenant), [DAILY]);
  assert.deepEqual(await id.questions.enabledPrograms(b.tenant), []);
  assert.deepEqual(await id.questions.checkAccess({ ...asUser(b.tenant, ua), permission: "cycle:read" }), { allowed: false, reason: "no-user" });
  assert.deepEqual(await id.questions.checkAccess({ ...asUser(b.tenant, ub), permission: "cycle:read", programId: DAILY }), { allowed: false, reason: "program-not-enabled" });
  await assert.rejects(
    id.commands.addUser(a.tenant, { issuer: "idp", externalSubject: "same", roles: [] }, a.by),
    "the same sign-in twice in one tenant is refused",
  );
});

dbTest("enabling and disabling a program announces once per change, with identifiers only", async () => {
  const { tenant, by } = await tenantWith("Events");
  assert.equal(await id.commands.enableProgram(tenant, DAILY, by), true);
  assert.equal(await id.commands.enableProgram(tenant, DAILY, by), false);
  assert.equal(await id.commands.disableProgram(tenant, DAILY, by), true);
  assert.equal(await id.commands.disableProgram(tenant, DAILY, by), false);
  assert.equal(await id.commands.enableProgram(tenant, DAILY, by), true);

  const events = await eventsFor(tenant);
  assert.deepEqual(events.map((e) => e.type), ["identity.program-enabled", "identity.program-disabled", "identity.program-enabled"]);
  for (const e of events) assert.deepEqual(Object.keys(e).sort(), ["eventId", "occurredAt", "programId", "tenantId", "type"]);

  await id.outbox.markPublished(events.map((e) => e.eventId));
  await id.outbox.markPublished(events.map((e) => e.eventId)); // safe to repeat
  assert.deepEqual(await eventsFor(tenant), []);
});

dbTest("an announcement and its change succeed or fail together", async () => {
  const { tenant, by } = await tenantWith("Atomic");
  await assert.rejects(
    db.transaction().execute(async (tx) => {
      await q(tx).insertInto("tenant_programs").values({ tenant_id: tenant, program_id: DAILY, enabled_by: by }).execute();
      await announce(tx, { type: "identity.program-enabled", tenantId: tenant, programId: DAILY });
      throw new Error("fail after both writes");
    }),
  );
  assert.deepEqual(await id.questions.enabledPrograms(tenant), []);
  assert.deepEqual(await eventsFor(tenant), []);
});

dbTest("unknown roles are refused", async () => {
  const { tenant, by } = await tenantWith("Roles");
  await assert.rejects(id.commands.addUser(tenant, { issuer: "idp", externalSubject: "x", roles: ["BOSS" as never] }, by), RangeError);
});

dbTest("running the migrations again applies nothing", async () => {
  assert.deepEqual(await migrate(url!), []);
});
