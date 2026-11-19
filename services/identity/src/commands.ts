// What the admin and onboarding screens ask Identity to do. Each command is one transaction;
// a command that announces something writes the event in that same transaction.
import { programId, tenantId, type ProgramId, type TenantId } from "@shared/kernel";
import { TENANT_ROLES, type PlatformUserId, type TenantRole, type UserId } from "../contract/index.ts";
import { q, type Db } from "./db.ts";
import { announce } from "./outbox.ts";

function role(r: string): TenantRole {
  if (!(TENANT_ROLES as readonly string[]).includes(r)) throw new RangeError(`unknown role "${r}"`);
  return r as TenantRole;
}

export interface NewUser {
  readonly issuer: string;
  readonly externalSubject: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly roles: readonly TenantRole[];
}

export function identityCommands(db: Db) {
  return {
    async createTenant(name: string): Promise<TenantId> {
      const row = await q(db).insertInto("tenants").values({ name }).returning("tenant_id").executeTakeFirstOrThrow();
      return tenantId(row.tenant_id);
    },

    async createPlatformUser(u: { issuer: string; externalSubject: string; email?: string; displayName?: string }): Promise<PlatformUserId> {
      const row = await q(db)
        .insertInto("platform_users")
        .values({ issuer: u.issuer, external_subject: u.externalSubject, email: u.email ?? null, display_name: u.displayName ?? null, platform_role: "SYSTEM_ADMIN" })
        .returning("platform_user_id")
        .executeTakeFirstOrThrow();
      return row.platform_user_id as PlatformUserId;
    },

    /** `by` is the id of whoever does this: a user or a platform user. */
    async addUser(tenant: TenantId, u: NewUser, by: string): Promise<UserId> {
      const roles = u.roles.map(role);
      return db.transaction().execute(async (tx) => {
        const row = await q(tx)
          .insertInto("users")
          .values({
            tenant_id: tenant,
            issuer: u.issuer,
            external_subject: u.externalSubject,
            email: u.email ?? null,
            display_name: u.displayName ?? null,
            created_by: by,
          })
          .returning("user_id")
          .executeTakeFirstOrThrow();
        if (roles.length > 0) {
          await q(tx)
            .insertInto("user_roles")
            .values(roles.map((r) => ({ tenant_id: tenant, user_id: row.user_id, role: r, granted_by: by })))
            .execute();
        }
        return row.user_id as UserId;
      });
    },

    async grantRole(tenant: TenantId, user: UserId, r: TenantRole, by: string): Promise<void> {
      role(r);
      await db.transaction().execute(async (tx) => {
        const held = await q(tx)
          .selectFrom("user_roles")
          .select("role")
          .where("tenant_id", "=", tenant)
          .where("user_id", "=", user)
          .where("role", "=", r)
          .where("revoked_at", "is", null)
          .executeTakeFirst();
        if (held) return; // already held: nothing changes
        await q(tx).insertInto("user_roles").values({ tenant_id: tenant, user_id: user, role: r, granted_by: by }).execute();
      });
    },

    async revokeRole(tenant: TenantId, user: UserId, r: TenantRole, by: string): Promise<void> {
      await q(db)
        .updateTable("user_roles")
        .set({ revoked_at: new Date(), revoked_by: by })
        .where("tenant_id", "=", tenant)
        .where("user_id", "=", user)
        .where("role", "=", r)
        .where("revoked_at", "is", null)
        .execute();
    },

    /** null removes the restriction (every enabled program); a list limits the user to those programs. */
    async setProgramRestriction(tenant: TenantId, user: UserId, programs: readonly ProgramId[] | null): Promise<void> {
      await db.transaction().execute(async (tx) => {
        await q(tx).deleteFrom("user_programs").where("tenant_id", "=", tenant).where("user_id", "=", user).execute();
        if (programs && programs.length > 0) {
          await q(tx)
            .insertInto("user_programs")
            .values([...new Set(programs)].map((p) => ({ tenant_id: tenant, user_id: user, program_id: programId(p) })))
            .execute();
        }
      });
    },

    async disableUser(tenant: TenantId, user: UserId, by: string): Promise<void> {
      await q(db)
        .updateTable("users")
        .set({ status: "DISABLED", disabled_at: new Date(), disabled_by: by })
        .where("tenant_id", "=", tenant)
        .where("user_id", "=", user)
        .where("status", "=", "ACTIVE")
        .execute();
    },

    /** Idempotent: enabling an enabled program changes nothing and announces nothing. */
    async enableProgram(tenant: TenantId, program: ProgramId, by: string): Promise<boolean> {
      return db.transaction().execute(async (tx) => {
        const row = await q(tx)
          .selectFrom("tenant_programs")
          .select("disabled_at")
          .where("tenant_id", "=", tenant)
          .where("program_id", "=", program)
          .forUpdate()
          .executeTakeFirst();
        if (row && row.disabled_at === null) return false;
        if (row) {
          await q(tx)
            .updateTable("tenant_programs")
            .set({ enabled_at: new Date(), enabled_by: by, disabled_at: null, disabled_by: null })
            .where("tenant_id", "=", tenant)
            .where("program_id", "=", program)
            .execute();
        } else {
          await q(tx).insertInto("tenant_programs").values({ tenant_id: tenant, program_id: program, enabled_by: by }).execute();
        }
        await announce(tx, { type: "identity.program-enabled", tenantId: tenant, programId: program });
        return true;
      });
    },

    /** Idempotent: disabling a program that is not enabled changes nothing and announces nothing. */
    async disableProgram(tenant: TenantId, program: ProgramId, by: string): Promise<boolean> {
      return db.transaction().execute(async (tx) => {
        const row = await q(tx)
          .selectFrom("tenant_programs")
          .select("disabled_at")
          .where("tenant_id", "=", tenant)
          .where("program_id", "=", program)
          .forUpdate()
          .executeTakeFirst();
        if (!row || row.disabled_at !== null) return false;
        await q(tx)
          .updateTable("tenant_programs")
          .set({ disabled_at: new Date(), disabled_by: by })
          .where("tenant_id", "=", tenant)
          .where("program_id", "=", program)
          .execute();
        await announce(tx, { type: "identity.program-disabled", tenantId: tenant, programId: program });
        return true;
      });
    },
  };
}

export type IdentityCommands = ReturnType<typeof identityCommands>;
