// Loads the facts the access decision needs. Every query is scoped by tenant.
import { programId, tenantId, type ProgramId, type TenantId } from "@shared/kernel";
import { TENANT_ROLES, type AccessQuery, type TenantRole } from "../contract/index.ts";
import type { AccessFacts } from "./access.ts";
import { q, type Queryable } from "./db.ts";

const isRole = (r: string): r is TenantRole => (TENANT_ROLES as readonly string[]).includes(r);

export async function loadEnabledPrograms(db: Queryable, tenant: TenantId): Promise<ProgramId[]> {
  const rows = await q(db)
    .selectFrom("tenant_programs")
    .select("program_id")
    .where("tenant_id", "=", tenant)
    .where("disabled_at", "is", null)
    .orderBy("program_id")
    .execute();
  return rows.map((r) => programId(r.program_id));
}

export async function loadAccessFacts(db: Queryable, query: AccessQuery): Promise<AccessFacts> {
  const tenant = tenantId(query.tenantId);
  const enabledPrograms = await loadEnabledPrograms(db, tenant);

  if (query.actor.kind === "platform") {
    const p = await q(db)
      .selectFrom("platform_users")
      .select("platform_role")
      .where("platform_user_id", "=", query.actor.platformUserId)
      .where("status", "=", "ACTIVE")
      .executeTakeFirst();
    return { platformRole: p?.platform_role ?? null, user: null, enabledPrograms };
  }

  const userId = query.actor.userId;
  const u = await q(db)
    .selectFrom("users")
    .select("status")
    .where("tenant_id", "=", tenant)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!u) return { platformRole: null, user: null, enabledPrograms };

  const roles = await q(db)
    .selectFrom("user_roles")
    .select("role")
    .where("tenant_id", "=", tenant)
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
  const restriction = await q(db)
    .selectFrom("user_programs")
    .select("program_id")
    .where("tenant_id", "=", tenant)
    .where("user_id", "=", userId)
    .execute();

  return {
    platformRole: null,
    user: {
      status: u.status,
      roles: roles.map((r) => r.role).filter(isRole),
      programRestriction: restriction.length === 0 ? null : restriction.map((r) => programId(r.program_id)),
    },
    enabledPrograms,
  };
}
