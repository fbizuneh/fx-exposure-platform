// Table types for the identity schema. Keep in step with migrations/.
import type { Generated } from "kysely";

type Status = "ACTIVE" | "DISABLED";

export interface IdentityDatabase {
  tenants: {
    tenant_id: Generated<string>;
    name: string;
    status: Generated<Status>;
    created_at: Generated<Date>;
  };
  users: {
    tenant_id: string;
    user_id: Generated<string>;
    issuer: string;
    external_subject: string;
    email: string | null;
    display_name: string | null;
    status: Generated<Status>;
    created_at: Generated<Date>;
    created_by: string | null;
    disabled_at: Date | null;
    disabled_by: string | null;
  };
  platform_users: {
    platform_user_id: Generated<string>;
    issuer: string;
    external_subject: string;
    email: string | null;
    display_name: string | null;
    platform_role: "SYSTEM_ADMIN";
    status: Generated<Status>;
    created_at: Generated<Date>;
  };
  user_roles: {
    tenant_id: string;
    user_id: string;
    role: string;
    granted_at: Generated<Date>;
    granted_by: string;
    revoked_at: Date | null;
    revoked_by: string | null;
  };
  user_programs: {
    tenant_id: string;
    user_id: string;
    program_id: string;
  };
  tenant_programs: {
    tenant_id: string;
    program_id: string;
    enabled_at: Generated<Date>;
    enabled_by: string;
    disabled_at: Date | null;
    disabled_by: string | null;
  };
  outbox: {
    event_id: string;
    tenant_id: string;
    type: string;
    payload: string;
    created_at: Generated<Date>;
    seq: Generated<string>;
    published_at: Date | null;
  };
}
