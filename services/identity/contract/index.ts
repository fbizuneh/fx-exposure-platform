// Published questions and events of Identity. Other services import this file, never src/.
import type { ProgramId, TenantId } from "@shared/kernel";

declare const brand: unique symbol;
/** A person known to Identity. Defined here, not in the shared kernel. */
export type UserId = string & { readonly [brand]: "UserId" };

export const TENANT_ROLES = [
  "VIEWER",
  "TREASURY_ANALYST",
  "TREASURY_REVIEWER",
  "TREASURY_APPROVER",
  "TREASURY_ADMIN",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const PLATFORM_ROLES = ["SYSTEM_ADMIN"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PERMISSIONS = [
  "program:read",
  "program:manage",
  "cycle:read",
  "cycle:initiate",
  "cycle:skip",
  "cycle:approve",
  "exposure:read",
  "hedge-recommendation:read",
  "hedge-recommendation:generate",
  "hedge-recommendation:review",
  "hedge-recommendation:accept",
  "hedge-recommendation:dismiss",
  "hedge-recommendation:override",
  "hedge-policy:read",
  "hedge-policy:manage",
  "hedge-policy:activate",
  "data-source:read",
  "data-source:import",
  "data-source:validate",
  "data-source:map",
  "data-source:publish",
  "data-quality:read",
  "data-quality:manage",
  "source-connector:read",
  "source-connector:manage",
  "source-connector:execute",
  "source-connector:observe",
  "master-data:read",
  "master-data:manage",
  "fx-rate:read",
  "fx-rate:manage",
  "fx-trade:read",
  "fx-trade:manage",
  "authorization:manage",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** May this user do this in this tenant, and in this program when one is given? */
export interface AccessQuery {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly permission: Permission;
  readonly programId?: ProgramId;
}

export type DenyReason =
  | "no-membership"
  | "membership-disabled"
  | "permission-missing"
  | "program-not-enabled"
  | "program-restricted";

export type AccessDecision =
  | { readonly allowed: true; readonly via: "membership" | "platform-role" }
  | { readonly allowed: false; readonly reason: DenyReason };

/** The questions Identity answers. Inside the deployable this is a direct call. */
export interface IdentityQuestions {
  checkAccess(query: AccessQuery): Promise<AccessDecision>;
  enabledPrograms(tenantId: TenantId): Promise<readonly ProgramId[]>;
}

/** Events carry identifiers only; the receiver asks Identity for detail. */
interface IdentityEvent {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}
export interface ProgramEnabled extends IdentityEvent {
  readonly type: "identity.program-enabled";
  readonly programId: ProgramId;
}
export interface ProgramDisabled extends IdentityEvent {
  readonly type: "identity.program-disabled";
  readonly programId: ProgramId;
}
export type IdentityEvents = ProgramEnabled | ProgramDisabled;
