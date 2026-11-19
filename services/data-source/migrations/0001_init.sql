-- Data Source schema, first migration (docs/decisions/0006). Every table carries tenant_id.
-- A batch is never edited. A later batch supersedes it; its balances and issues stay as evidence.

CREATE SCHEMA IF NOT EXISTS data_source;

CREATE TABLE data_source.programs (
  tenant_id     uuid NOT NULL,
  program_id    text NOT NULL,
  program_type  text NOT NULL,
  enabled       boolean NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, program_id)
);

-- program-scoped
CREATE TABLE data_source.mapping_rules (
  tenant_id      uuid NOT NULL,
  rule_id        uuid NOT NULL,
  program_id     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('INCLUDE', 'EXCLUDE')),
  target_type    text NOT NULL CHECK (target_type IN ('ACCOUNT', 'NODE')),
  chart_code     text NOT NULL,
  target_code    text NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date,
  source_system  text,
  entity_code    text,
  dimensions     jsonb,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX mapping_rules_active ON data_source.mapping_rules (tenant_id, valid_from, valid_to);

CREATE TABLE data_source.batches (
  tenant_id       uuid NOT NULL,
  batch_id        uuid NOT NULL,
  source_system   text NOT NULL,
  data_type       text NOT NULL DEFAULT 'GL_BALANCE' CHECK (data_type IN ('GL_BALANCE')),
  as_of           date NOT NULL,
  chart_code      text NOT NULL,
  content_hash    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED')),
  failure_reason  text,
  received_count  integer NOT NULL,
  included_count  integer NOT NULL DEFAULT 0,
  excluded_count  integer NOT NULL DEFAULT 0,
  blocked_count   integer NOT NULL DEFAULT 0,
  superseded_by   uuid,
  received_by     text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id),
  CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL))
);
CREATE INDEX batches_current ON data_source.batches (tenant_id, source_system, as_of) WHERE superseded_by IS NULL;

-- program-scoped
CREATE TABLE data_source.balances (
  tenant_id          uuid NOT NULL,
  balance_id         uuid NOT NULL,
  batch_id           uuid NOT NULL,
  source_system      text NOT NULL,
  as_of              date NOT NULL,
  row_number         integer NOT NULL,
  record_key         text NOT NULL,
  entity_code        text,
  entity_id          text,
  chart_code         text NOT NULL,
  account_number     text,
  account_id         text,
  currency           text,
  amount             numeric(24, 4),
  dimensions         jsonb NOT NULL DEFAULT '{}',
  outcome            text NOT NULL CHECK (outcome IN ('INCLUDED', 'EXCLUDED', 'BLOCKED')),
  program_id         text,
  matched_rule_ids   jsonb NOT NULL DEFAULT '[]',
  raw                jsonb,
  PRIMARY KEY (tenant_id, balance_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES data_source.batches (tenant_id, batch_id),
  CHECK (outcome <> 'INCLUDED' OR (program_id IS NOT NULL AND amount IS NOT NULL AND entity_id IS NOT NULL AND account_id IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX balances_included ON data_source.balances (tenant_id, program_id, as_of) WHERE outcome = 'INCLUDED';
CREATE INDEX balances_batch ON data_source.balances (tenant_id, batch_id);

CREATE TABLE data_source.data_quality_issues (
  tenant_id    uuid NOT NULL,
  issue_id     uuid NOT NULL,
  batch_id     uuid NOT NULL,
  balance_id   uuid,
  rule_code    text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('ERROR', 'WARNING')),
  description  text NOT NULL,
  status       text NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
  raised_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  PRIMARY KEY (tenant_id, issue_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES data_source.batches (tenant_id, batch_id)
);
CREATE INDEX issues_batch ON data_source.data_quality_issues (tenant_id, batch_id);

CREATE TABLE data_source.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
