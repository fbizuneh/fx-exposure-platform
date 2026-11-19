-- Exposure Management schema, first migration (docs/decisions/0007). Every table carries tenant_id.
-- Settings are appended as versions; a cycle keeps a copy of the settings it ran with.

CREATE SCHEMA IF NOT EXISTS exposure_management;

CREATE TABLE exposure_management.programs (
  tenant_id     uuid NOT NULL,
  program_id    text NOT NULL,
  name          text NOT NULL,
  program_type  text NOT NULL CHECK (program_type IN ('BALANCE_SHEET', 'CASH_FLOW', 'BUDGET_TO_CASH', 'IN_HOUSE_BANK')),
  enabled       boolean NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, program_id)
);

-- program-scoped
CREATE TABLE exposure_management.program_settings (
  tenant_id      uuid NOT NULL,
  program_id     text NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date,
  netting_level  text NOT NULL CHECK (netting_level IN ('ENTITY_PAIR', 'CORPORATE_PAIR', 'REGION_PAIR')),
  bucket_scheme  jsonb NOT NULL,
  schedule       jsonb,
  changed_by     text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, program_id, valid_from),
  FOREIGN KEY (tenant_id, program_id) REFERENCES exposure_management.programs (tenant_id, program_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- Only one version of a program's settings is open at a time.
CREATE UNIQUE INDEX program_settings_one_open ON exposure_management.program_settings (tenant_id, program_id) WHERE valid_to IS NULL;

-- program-scoped
CREATE TABLE exposure_management.cycles (
  tenant_id         uuid NOT NULL,
  cycle_id          uuid NOT NULL,
  program_id        text NOT NULL,
  as_of             date NOT NULL,
  stage             text NOT NULL CHECK (stage IN ('INITIATED', 'IN_PROGRESS', 'COMPLETED')),
  outcome           text CHECK (outcome IN ('SKIPPED', 'DELETED')),
  outcome_reason    text,
  settings          jsonb NOT NULL,
  rerun_count       integer NOT NULL DEFAULT 0,
  current_run_id    text,
  approved_at       timestamptz,
  approved_by       text,
  initiated_by      text NOT NULL,
  initiated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cycle_id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES exposure_management.programs (tenant_id, program_id),
  CHECK ((outcome IS NULL) = (outcome_reason IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK (approved_at IS NULL OR (stage = 'COMPLETED' AND outcome IS NULL))
);
-- One open cycle per tenant and program: not approved, skipped or deleted.
CREATE UNIQUE INDEX cycles_one_open ON exposure_management.cycles (tenant_id, program_id) WHERE outcome IS NULL AND approved_at IS NULL;
CREATE INDEX cycles_by_program ON exposure_management.cycles (tenant_id, program_id, as_of);

CREATE TABLE exposure_management.cycle_history (
  tenant_id  uuid NOT NULL,
  cycle_id   uuid NOT NULL,
  seq        integer NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('INITIATED', 'RUN_STARTED', 'RUN_FINISHED', 'RERUN', 'SKIPPED', 'DELETED', 'APPROVED')),
  by_who     text,
  at         timestamptz NOT NULL DEFAULT now(),
  note       text,
  PRIMARY KEY (tenant_id, cycle_id, seq),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES exposure_management.cycles (tenant_id, cycle_id)
);

CREATE TABLE exposure_management.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
