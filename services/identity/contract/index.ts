// Published questions and events of Identity. Other services import this file, never src/.
import type { ChangeRecordFields } from "@services/audit/contract";
import type { ProgramId, TenantId } from "@shared/kernel";

declare const brand: unique symbol;
/** A user of one tenant. Defined here, not in the shared kernel. */
export type UserId = string & { readonly [brand]: "UserId" };
/** Platform staff, outside every tenant. */
export type PlatformUserId = string & { readonly [brand]: "PlatformUserId" };

export type Actor =
  | { readonly kind: "user"; readonly userId: UserId }
  | { readonly kind: "platform"; readonly platformUserId: PlatformUserId };

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
  "exposure:approve",
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
  readonly actor: Actor;
  readonly permission: Permission;
  readonly programId?: ProgramId;
}

export type DenyReason =
  | "no-user"
  | "user-disabled"
  | "permission-missing"
  | "program-not-enabled"
  | "program-restricted";

export type AccessDecision =
  | { readonly allowed: true; readonly via: "user" | "platform-role" }
  | { readonly allowed: false; readonly reason: DenyReason };

/** Which programs an actor is limited to. Not restricted means every program the tenant has, including ones enabled later. */
export interface ProgramScope {
  readonly restricted: boolean;
  /** The programs the actor is limited to when restricted; empty when not restricted or when the actor has no access. */
  readonly programs: readonly ProgramId[];
}

/** The questions Identity answers. Inside the deployable this is a direct call. */
export interface IdentityQuestions {
  checkAccess(query: AccessQuery): Promise<AccessDecision>;
  enabledPrograms(tenantId: TenantId): Promise<readonly ProgramId[]>;
  /** The program scope of an actor in a tenant, for services that list records across programs (decision 0001). */
  programScope(tenantId: TenantId, actor: Actor): Promise<ProgramScope>;
  /** Platform level, no tenant: the IDs of the tenants that are active, in a stable order. Only the runtime's timer loop calls it (decision 0023). */
  activeTenants(): Promise<readonly TenantId[]>;
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

/** A change record for Audit (decision 0012): who did what to which record. Identifiers and field names only. */
export interface IdentityChangeRecorded extends ChangeRecordFields {
  readonly type: "identity.change-recorded";
  readonly eventId: string;
  readonly occurredAt: string;
}
export type IdentityEvents = ProgramEnabled | ProgramDisabled | IdentityChangeRecorded;
