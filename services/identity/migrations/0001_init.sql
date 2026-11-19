-- Identity schema, first migration. Every table carries tenant_id unless marked exempt;
-- program-scoped tables also carry program_id. No keys point outside this schema.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.tenants (
  tenant_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- tenant-exempt: a person can belong to several tenants, so a user belongs to none
CREATE TABLE identity.users (
  user_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer            text NOT NULL,
  external_subject  text NOT NULL,
  email             text,
  display_name      text,
  platform_role     text CHECK (platform_role IS NULL OR platform_role = 'SYSTEM_ADMIN'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, external_subject)
);

CREATE TABLE identity.memberships (
  tenant_id      uuid NOT NULL REFERENCES identity.tenants (tenant_id),
  membership_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES identity.users (user_id),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  disabled_at    timestamptz,
  disabled_by    uuid,
  PRIMARY KEY (tenant_id, membership_id),
  UNIQUE (tenant_id, user_id)
);

-- Role names are fixed in code (docs/decisions/0002); the service validates them.
CREATE TABLE identity.membership_roles (
  tenant_id      uuid NOT NULL,
  membership_id  uuid NOT NULL,
  role           text NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  granted_by     uuid NOT NULL,
  revoked_at     timestamptz,
  revoked_by     uuid,
  PRIMARY KEY (tenant_id, membership_id, role, granted_at),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES identity.memberships (tenant_id, membership_id)
);

-- program-scoped: no rows for a membership means no restriction (every enabled program)
CREATE TABLE identity.membership_programs (
  tenant_id      uuid NOT NULL,
  membership_id  uuid NOT NULL,
  program_id     text NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, program_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES identity.memberships (tenant_id, membership_id)
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

CREATE INDEX memberships_user_idx ON identity.memberships (user_id, status);
CREATE INDEX membership_roles_active_idx ON identity.membership_roles (tenant_id, membership_id) WHERE revoked_at IS NULL;
CREATE INDEX outbox_unpublished_idx ON identity.outbox (created_at) WHERE published_at IS NULL;
