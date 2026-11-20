// Permission checks go through Identity's published question. Nothing here knows how roles map to permissions.
import type { TenantId, ProgramId } from "@shared/kernel";
import type { Actor, DenyReason, IdentityQuestions, Permission } from "@services/identity/contract";

export type IdentityPort = Pick<IdentityQuestions, "checkAccess" | "programScope">;

export class AccessDenied extends Error {
  readonly reason: DenyReason;
  constructor(permission: Permission, reason: DenyReason) {
    super(`not allowed (${permission}): ${reason}`);
    this.reason = reason;
  }
}

export async function require_(access: IdentityPort, tenantId: TenantId, actor: Actor, permission: Permission, programId?: ProgramId): Promise<void> {
  const d = await access.checkAccess(programId === undefined ? { tenantId, actor, permission } : { tenantId, actor, permission, programId });
  if (!d.allowed) throw new AccessDenied(permission, d.reason);
}
