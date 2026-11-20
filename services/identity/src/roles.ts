// Fixed roles and the permissions each holds (docs/decisions/0002).
import { PERMISSIONS, type Permission, type TenantRole } from "../contract/index.ts";

// The audit trail is for approvers and admins, not every reader (decision 0012).
const reads = PERMISSIONS.filter((p) => p.endsWith(":read") && p !== "audit:read");

const reviewer: Permission[] = [
  ...reads,
  "cycle:initiate",
  "hedge-recommendation:generate",
  "hedge-recommendation:review",
  "hedge-recommendation:dismiss",
];

export const ROLE_PERMISSIONS: Readonly<Record<TenantRole, ReadonlySet<Permission>>> = {
  VIEWER: new Set(reads),
  TREASURY_ANALYST: new Set<Permission>([
    ...reads,
    "data-source:import",
    "data-source:validate",
    "data-source:map",
    "data-source:publish",
    "cycle:initiate",
    "hedge-recommendation:generate",
  ]),
  TREASURY_REVIEWER: new Set(reviewer),
  TREASURY_APPROVER: new Set<Permission>([...reviewer, "audit:read", "exposure:approve", "cycle:approve", "cycle:skip", "hedge-recommendation:accept"]),
  TREASURY_ADMIN: new Set(PERMISSIONS),
};
