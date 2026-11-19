-- Identity schema, first migration (docs/decisions/0001 to 0003). Every table carries tenant_id unless
-- marked exempt; program-scoped tables also carry program_id. No keys point outside this schema.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.tenants (
  tenant_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A user belongs to one tenant. A person who needs two tenants has a separate user in each.
CREATE TABLE identity.users (
  tenant_id         uuid NOT NULL REFERENCES identity.tenants (tenant_id),
  user_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer            text NOT NULL,
  external_subject  text NOT NULL,
  email             text,
  display_name      text,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  disabled_at       timestamptz,
  disabled_by       uuid,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, issuer, external_subject)
);

-- tenant-exempt: platform staff (System Admin) belong to the platform, not to a tenant
CREATE TABLE identity.platform_users (
  platform_user_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer            text NOT NULL,
  external_subject  text NOT NULL,
  email             text,
  display_name      text,
  platform_role     text NOT NULL CHECK (platform_role = 'SYSTEM_ADMIN'),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, external_subject)
);

-- Role names are fixed in code (docs/decisions/0002); the service validates them.
CREATE TABLE identity.user_roles (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid,
  PRIMARY KEY (tenant_id, user_id, role, granted_at),
  FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, user_id)
);

-- program-scoped: no rows for a user means no restriction (every enabled program)
CREATE TABLE identity.user_programs (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  program_id  text NOT NULL,
  PRIMARY KEY (tenant_id, user_id, program_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, user_id)
);

-- program-scoped: the programs a tenant has enabled; Exposure Management validates the combination
CREATE TABLE identity.tenant_programs (
  tenant_id    uuid NOT NULL REFERENCES identity.tenants (tenant_id),
  program_id   text NOT NULL,
  enabled_at   timestamptz NOT NULL DEFAULT now(),
  enabled_by   uuid NOT NULL,
  disabled_at  timestamptz,
  disabled_by  uuid,
  PRIMARY KEY (tenant_id, program_id)
);

CREATE TABLE identity.invitations (
  tenant_id      uuid NOT NULL REFERENCES identity.tenants (tenant_id),
  invitation_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  role           text NOT NULL,
  token_hash     text NOT NULL,
  invited_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  PRIMARY KEY (tenant_id, invitation_id)
);

-- Events are written here in the same transaction as the change they announce.
CREATE TABLE identity.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE INDEX user_roles_active_idx ON identity.user_roles (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX outbox_unpublished_idx ON identity.outbox (created_at) WHERE published_at IS NULL;
