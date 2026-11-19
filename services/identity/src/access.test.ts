import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, TENANT_ROLES, type AccessQuery } from "../contract/index.ts";
import { decide, type AccessFacts } from "./access.ts";
import { ROLE_PERMISSIONS } from "./roles.ts";

const q = (permission: AccessQuery["permission"], programId?: string): AccessQuery =>
  ({ tenantId: "t", userId: "u", permission, programId }) as unknown as AccessQuery;

const facts = (over: Partial<AccessFacts> = {}, roles: AccessFacts["membership"] = null): AccessFacts => ({
  platformRole: null,
  membership: roles,
  enabledPrograms: ["DAILY", "MONTHLY"] as unknown as AccessFacts["enabledPrograms"],
  ...over,
});
const member = (role: (typeof TENANT_ROLES)[number], restriction: string[] | null = null): AccessFacts["membership"] => ({
  status: "ACTIVE",
  roles: [role],
  programRestriction: restriction as unknown as AccessFacts["membership"] extends infer M ? (M extends { programRestriction: infer R } ? R : never) : never,
});

test("every role only holds known permissions, and the admin holds all", () => {
  for (const role of TENANT_ROLES) for (const p of ROLE_PERMISSIONS[role]) assert.ok(PERMISSIONS.includes(p), `${role} ${p}`);
  assert.equal(ROLE_PERMISSIONS.TREASURY_ADMIN.size, PERMISSIONS.length);
});

test("role ladder: viewer reads, analyst imports, reviewer reviews, approver approves", () => {
  assert.ok(ROLE_PERMISSIONS.VIEWER.has("cycle:read"));
  assert.ok(!ROLE_PERMISSIONS.VIEWER.has("cycle:initiate"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_ANALYST.has("data-source:publish"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_ANALYST.has("hedge-recommendation:review"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_REVIEWER.has("hedge-recommendation:review"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_REVIEWER.has("cycle:approve"));
  assert.ok(ROLE_PERMISSIONS.TREASURY_APPROVER.has("cycle:approve"));
  assert.ok(!ROLE_PERMISSIONS.TREASURY_APPROVER.has("authorization:manage"));
});

test("no membership and disabled membership are denied", () => {
  assert.deepEqual(decide(q("cycle:read"), facts()), { allowed: false, reason: "no-membership" });
  const disabled = { status: "DISABLED", roles: ["TREASURY_ADMIN"], programRestriction: null } as AccessFacts["membership"];
  assert.deepEqual(decide(q("cycle:read"), facts({}, disabled)), { allowed: false, reason: "membership-disabled" });
});

test("a missing permission is denied, a held one is allowed", () => {
  assert.deepEqual(decide(q("cycle:approve"), facts({}, member("TREASURY_ANALYST"))), { allowed: false, reason: "permission-missing" });
  assert.deepEqual(decide(q("cycle:approve"), facts({}, member("TREASURY_APPROVER"))), { allowed: true, via: "membership" });
});

test("a program must be enabled, and a restricted membership must list it", () => {
  const m = member("TREASURY_APPROVER");
  assert.deepEqual(decide(q("cycle:approve", "WEEKLY"), facts({}, m)), { allowed: false, reason: "program-not-enabled" });
  assert.deepEqual(decide(q("cycle:approve", "DAILY"), facts({}, m)), { allowed: true, via: "membership" });
  const restricted = member("TREASURY_APPROVER", ["MONTHLY"]);
  assert.deepEqual(decide(q("cycle:approve", "DAILY"), facts({}, restricted)), { allowed: false, reason: "program-restricted" });
  assert.deepEqual(decide(q("cycle:approve", "MONTHLY"), facts({}, restricted)), { allowed: true, via: "membership" });
  assert.deepEqual(decide(q("cycle:approve"), facts({}, restricted)), { allowed: true, via: "membership" });
});

test("the platform role is allowed in any tenant and says so", () => {
  assert.deepEqual(decide(q("authorization:manage", "WEEKLY"), facts({ platformRole: "SYSTEM_ADMIN" })), { allowed: true, via: "platform-role" });
});
