// The access decision, as a pure function of facts Identity holds. No database here.
import type { ProgramId } from "@shared/kernel";
import type { AccessDecision, AccessQuery, PlatformRole, TenantRole } from "../contract/index.ts";
import { ROLE_PERMISSIONS } from "./roles.ts";

export interface AccessFacts {
  /** Set when the actor is an active platform user. Platform roles sit outside every tenant. */
  readonly platformRole: PlatformRole | null;
  /** The user in the queried tenant, or null if there is none. */
  readonly user: {
    readonly status: "ACTIVE" | "DISABLED";
    readonly roles: readonly TenantRole[];
    /** null means no restriction: every enabled program. */
    readonly programRestriction: readonly ProgramId[] | null;
  } | null;
  /** Programs the tenant has enabled. */
  readonly enabledPrograms: readonly ProgramId[];
}

export function decide(query: AccessQuery, facts: AccessFacts): AccessDecision {
  if (facts.platformRole === "SYSTEM_ADMIN") return { allowed: true, via: "platform-role" };

  const u = facts.user;
  if (u === null) return { allowed: false, reason: "no-user" };
  if (u.status !== "ACTIVE") return { allowed: false, reason: "user-disabled" };

  if (!u.roles.some((role) => ROLE_PERMISSIONS[role].has(query.permission))) {
    return { allowed: false, reason: "permission-missing" };
  }

  if (query.programId !== undefined) {
    if (!facts.enabledPrograms.includes(query.programId)) return { allowed: false, reason: "program-not-enabled" };
    if (u.programRestriction !== null && !u.programRestriction.includes(query.programId)) {
      return { allowed: false, reason: "program-restricted" };
    }
  }
  return { allowed: true, via: "user" };
}
