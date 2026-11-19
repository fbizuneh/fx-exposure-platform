// The access decision, as a pure function of facts Identity holds. No database here.
import type { ProgramId } from "@shared/kernel";
import type { AccessDecision, AccessQuery, PlatformRole, TenantRole } from "../contract/index.ts";
import { ROLE_PERMISSIONS } from "./roles.ts";

export interface AccessFacts {
  /** The user's platform role, if any. It sits outside every tenant. */
  readonly platformRole: PlatformRole | null;
  /** The user's membership in the queried tenant, or null if none. */
  readonly membership: {
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

  const m = facts.membership;
  if (m === null) return { allowed: false, reason: "no-membership" };
  if (m.status !== "ACTIVE") return { allowed: false, reason: "membership-disabled" };

  if (!m.roles.some((role) => ROLE_PERMISSIONS[role].has(query.permission))) {
    return { allowed: false, reason: "permission-missing" };
  }

  if (query.programId !== undefined) {
    if (!facts.enabledPrograms.includes(query.programId)) return { allowed: false, reason: "program-not-enabled" };
    if (m.programRestriction !== null && !m.programRestriction.includes(query.programId)) {
      return { allowed: false, reason: "program-restricted" };
    }
  }
  return { allowed: true, via: "membership" };
}
