-- Master Data schema, first migration (docs/decisions/0004). Every table carries tenant_id.
-- Versioned tables hold one row per version: valid on D when valid_from <= D < valid_to (null = open).
-- The database refuses overlapping versions. btree_gist is needed for that; it is a trusted extension.

CREATE SCHEMA IF NOT EXISTS master_data;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA master_data;

CREATE TABLE master_data.tenant_settings (
  tenant_id      uuid PRIMARY KEY,
  max_end_share  numeric(4, 3) NOT NULL DEFAULT 0.200 CHECK (max_end_share >= 0 AND max_end_share <= 1),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE master_data.charts_of_accounts (
  tenant_id   uuid NOT NULL,
  chart_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chart_id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE master_data.entities (
  tenant_id                  uuid NOT NULL,
  entity_id                  uuid NOT NULL,
  valid_from                 date NOT NULL,
  valid_to                   date,
  source_system              text NOT NULL,
  code                       text NOT NULL,
  name                       text NOT NULL,
  entity_type                text NOT NULL CHECK (entity_type IN
    ('GROUP', 'REGION', 'LEGAL_ENTITY', 'BUSINESS_UNIT', 'DIVISION', 'PROFIT_CENTER', 'COST_CENTER', 'PROJECT')),
  parent_entity_id           uuid,
  country_code               text,
  functional_currency        text,
  is_legal_entity            boolean NOT NULL,
  is_treasury_entity         boolean NOT NULL,
  is_hedge_execution_entity  boolean NOT NULL,
  batch_id                   uuid NOT NULL,
  PRIMARY KEY (tenant_id, entity_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (NOT is_legal_entity OR functional_currency IS NOT NULL),
  EXCLUDE USING gist (tenant_id WITH =, entity_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, code WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);

CREATE TABLE master_data.gl_hierarchy_nodes (
  tenant_id       uuid NOT NULL,
  node_id         uuid NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date,
  source_system   text NOT NULL,
  chart_id        uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  classification  text NOT NULL CHECK (classification IN
    ('BALANCE_SHEET', 'ASSETS', 'LIABILITIES', 'EQUITY', 'INCOME_STATEMENT', 'REVENUE', 'COGS',
     'OPERATING_EXPENSES', 'OTHER_INCOME_EXPENSE')),
  parent_node_id  uuid,
  batch_id        uuid NOT NULL,
  PRIMARY KEY (tenant_id, node_id, valid_from),
  FOREIGN KEY (tenant_id, chart_id) REFERENCES master_data.charts_of_accounts (tenant_id, chart_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, node_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, chart_id WITH =, code WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);

CREATE TABLE master_data.accounts (
  tenant_id          uuid NOT NULL,
  account_id         uuid NOT NULL,
  valid_from         date NOT NULL,
  valid_to           date,
  source_system      text NOT NULL,
  chart_id           uuid NOT NULL,
  account_number     text NOT NULL,
  name               text NOT NULL,
  hierarchy_node_id  uuid,
  statement_type     text NOT NULL CHECK (statement_type IN ('BALANCE_SHEET', 'INCOME_STATEMENT', 'CASH_FLOW')),
  normal_balance     text NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  monetary_flag      boolean NOT NULL,
  fx_relevant_flag   boolean NOT NULL,
  batch_id           uuid NOT NULL,
  PRIMARY KEY (tenant_id, account_id, valid_from),
  FOREIGN KEY (tenant_id, chart_id) REFERENCES master_data.charts_of_accounts (tenant_id, chart_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, account_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, chart_id WITH =, account_number WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);

-- Every submitted change set, applied or not. Held ones wait here for release or rejection.
CREATE TABLE master_data.change_sets (
  tenant_id      uuid NOT NULL,
  batch_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  source_system  text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('ENTITY', 'HIERARCHY', 'ACCOUNT')),
  mode           text NOT NULL CHECK (mode IN ('SNAPSHOT', 'PARTIAL')),
  as_of          date NOT NULL,
  content_hash   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('APPLIED', 'HELD', 'REJECTED')),
  rows           jsonb NOT NULL,
  open_count     integer NOT NULL,
  end_count      integer NOT NULL,
  held_reason    text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  decided_at     timestamptz,
  PRIMARY KEY (tenant_id, batch_id)
);

-- A snapshot key (tenant, source, kind, date) is used once unless that snapshot was rejected.
CREATE UNIQUE INDEX change_sets_snapshot_key
  ON master_data.change_sets (tenant_id, source_system, kind, as_of)
  WHERE mode = 'SNAPSHOT' AND status <> 'REJECTED';

-- Events are written here in the same transaction as the change they announce.
CREATE TABLE master_data.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE INDEX entities_asof_idx ON master_data.entities (tenant_id, valid_from, valid_to);
CREATE INDEX accounts_asof_idx ON master_data.accounts (tenant_id, valid_from, valid_to);
CREATE INDEX gl_hierarchy_nodes_asof_idx ON master_data.gl_hierarchy_nodes (tenant_id, chart_id, valid_from, valid_to);
CREATE INDEX outbox_unpublished_idx ON master_data.outbox (created_at) WHERE published_at IS NULL;
