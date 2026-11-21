// Identity's entry point for app/ to wire. Other services never import this; they import contract/.
import type { TenantId } from "@shared/kernel";
import type { IdentityQuestions } from "../contract/index.ts";
import { decide } from "./access.ts";
import { recordChange } from "./change-record.ts";
import { identityCommands } from "./commands.ts";
import { connect, q, type Db } from "./db.ts";
import { loadAccessFacts, loadEnabledPrograms } from "./facts.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";

export function identityQuestions(db: Db): IdentityQuestions {
  return {
    async tenantByName(name) {
      const row = await q(db).selectFrom("tenants").select("tenant_id").where("name", "=", name).executeTakeFirst();
      return (row?.tenant_id ?? null) as TenantId | null;
    },
    async checkAccess(query) {
      const decision = decide(query, await loadAccessFacts(db, query));
      // Every use of the platform role is written to the trail (decision 0001), whether or not the tenant would have allowed it.
      if (decision.allowed && decision.via === "platform-role" && query.actor.kind === "platform") {
        const actor = `platform:${query.actor.platformUserId}`;
        await db.transaction().execute((tx) => recordChange(tx, { tenantId: query.tenantId, programId: query.programId ?? null, actor, action: "platform-role.used", targetType: "permission", targetId: query.permission, fields: [] }));
      }
      return decision;
    },
    async enabledPrograms(tenant) {
      return loadEnabledPrograms(db, tenant);
    },
    async programScope(tenant, actor) {
      const facts = await loadAccessFacts(db, { tenantId: tenant, actor, permission: "audit:read" });
      if (facts.platformRole !== null) return { restricted: false, programs: [] };
      const restriction = facts.user?.programRestriction ?? null;
      if (facts.user === null || facts.user.status !== "ACTIVE") return { restricted: true, programs: [] };
      return restriction === null ? { restricted: false, programs: [] } : { restricted: true, programs: restriction };
    },
    async activeTenants() {
      const rows = await q(db).selectFrom("tenants").select("tenant_id").where("status", "=", "ACTIVE").orderBy("created_at").orderBy("tenant_id").execute();
      return rows.map((r) => r.tenant_id as TenantId);
    },
  };
}

export function createIdentity(db: Db) {
  return {
    questions: identityQuestions(db),
    commands: identityCommands(db),
    outbox: {
      pending: (limit?: number, now?: Date) => pendingEvents(db, limit, now),
      markPublished: (ids: readonly string[]) => markPublished(db, ids),
      recordFailure: (eventId: string, error: string, now: Date, policy: RetryPolicy) => recordFailure(db, eventId, error, now, policy),
      problems: () => deliveryProblems(db),
      retryStuck: (eventId: string, by: { tenantId: TenantId; actor: string }) => retryStuck(db, eventId, by),
    },
  };
}

export { connect };
export type { Db };
