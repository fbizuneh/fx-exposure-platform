import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, TENANT_ROLES, type AccessQuery, type TenantRole } from "../contract/index.ts";
import { decide, type AccessFacts } from "./access.ts";
import { ROLE_PERMISSIONS } from "./roles.ts";

type User = NonNullable<AccessFacts["user"]>;

const q = (permission: AccessQuery["permission"], programId?: string): AccessQuery =>
  ({ tenantId: "t", actor: { kind: "user", userId: "u" }, permission, programId }) as unknown as AccessQuery;

const user = (role: TenantRole, restriction: string[] | null = null): User => ({
  status: "ACTIVE",
  roles: [role],
  programRestriction: restriction as unknown as User["programRestriction"],
});

const facts = (u: AccessFacts["user"] = null, platformRole: AccessFacts["platformRole"] = null): AccessFacts => ({
  platformRole,
  user: u,
  enabledPrograms: ["DAILY", "MONTHLY"] as unknown as AccessFacts["enabledPrograms"],
});

test("every role only holds known permissions, and the admin holds all", () => {
  for (const role of TENANT_ROLES) for (const p of ROLE_PERMISSIONS[role]) assert.ok(PERMISSIONS.includes(p), `${role} ${p}`);
  assert.equal(ROLE_PERMISSIONS.TREASURY_ADMIN.size, PERMISSIONS.length);
});

test("role ladder: viewer reads, analyst imports, reviewer reviews, approver approves and skips", () => {
  assert.ok(ROLE_PERMISSIONS.VIEWER.has("cycle:read"));
  assert.ok(!ROLE_PERMISSIONS.VIEWER.has("cycle:initiate"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_ANALYST.has("data-source:publish"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_ANALYST.has("hedge-recommendation:review"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_REVIEWER.has("hedge-recommendation:review"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_REVIEWER.has("cycle:approve"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_APPROVER.has("cycle:approve"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_APPROVER.has("cycle:skip"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_APPROVER.has("authorization:manage"));
});

test("no user in the tenant and a disabled user are denied", () => {
  assert.deepEqual(decide(q("cycle:read"), facts()), { allowed: false, reason: "no-user" });
  const disabled: User = { status: "DISABLED", roles: ["TREASURY_ADMIN"], programRestriction: null };
  assert.deepEqual(decide(q("cycle:read"), facts(disabled)), { allowed: false, reason: "user-disabled" });
});

test("a missing permission is denied, a held one is allowed", () => {
  assert.deepEqual(decide(q("cycle:approve"), facts(user("TREASURY_ANALYST"))), { allowed: false, reason: "permission-missing" });
  assert.deepEqual(decide(q("cycle:approve"), facts(user("TREASURY_APPROVER"))), { allowed: true, via: "user" });
});

test("a program must be enabled, and a restricted user must list it", () => {
  const u = user("TREASURY_APPROVER");
  assert.deepEqual(decide(q("cycle:approve", "WEEKLY"), facts(u)), { allowed: false, reason: "program-not-enabled" });
  assert.deepEqual(decide(q("cycle:approve", "DAILY"), facts(u)), { allowed: true, via: "user" });
  const restricted = user("TREASURY_APPROVER", ["MONTHLY"]);
  assert.deepEqual(decide(q("cycle:approve", "DAILY"), facts(restricted)), { allowed: false, reason: "program-restricted" });
  assert.deepEqual(decide(q("cycle:approve", "MONTHLY"), facts(restricted)), { allowed: true, via: "user" });
  assert.deepEqual(decide(q("cycle:approve"), facts(restricted)), { allowed: true, via: "user" });
});

test("a platform user is allowed in any tenant and says so", () => {
  assert.deepEqual(decide(q("authorization:manage", "WEEKLY"), facts(null, "SYSTEM_ADMIN")), { allowed: true, via: "platform-role" });
});

test("the audit trail is read by approvers and admins only (decision 0012)", () => {
  const holders = TENANT_ROLES.filter((r) => ROLE_PERMISSIONS[r].has("audit:read"));
  assert.deepEqual([...holders].sort(), ["TREASURY_ADMIN", "TREASURY_APPROVER"]);
});
