-- Exposure Analysis schema (docs/decisions/0008). Every table carries tenant_id; every program-scoped table carries program_id.
-- A run is saved when a cycle starts. WAITING runs hold no rows; FINISHED runs are complete and immutable.

CREATE SCHEMA IF NOT EXISTS exposure_analysis;

-- program-scoped
CREATE TABLE exposure_analysis.runs (
  tenant_id         uuid NOT NULL,
  run_id            uuid NOT NULL,
  program_id        text NOT NULL,
  cycle_id          uuid NOT NULL,
  as_of             date NOT NULL,
  trigger_event_id  uuid NOT NULL,
  status            text NOT NULL CHECK (status IN ('WAITING', 'FINISHED', 'SUPERSEDED')),
  wait_reason       text,
  netting_level     text NOT NULL,
  display_currency  text NOT NULL,
  counts            jsonb,
  blocked_count     integer,
  warnings          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  attempted_at      timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  frozen_at         timestamptz,
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, trigger_event_id),
  CHECK ((status = 'WAITING') = (wait_reason IS NOT NULL)),
  CHECK ((status = 'FINISHED') = (finished_at IS NOT NULL) OR status = 'SUPERSEDED'),
  CHECK (frozen_at IS NULL OR status = 'FINISHED')
);
-- A cycle has one current run: every earlier run is superseded.
CREATE UNIQUE INDEX runs_one_current ON exposure_analysis.runs (tenant_id, cycle_id) WHERE status <> 'SUPERSEDED';

-- program-scoped
CREATE TABLE exposure_analysis.baseline_rows (
  tenant_id            uuid NOT NULL,
  program_id           text NOT NULL,
  run_id               uuid NOT NULL,
  row_no               integer NOT NULL,
  source_system        text NOT NULL,
  batch_id             text NOT NULL,
  record_id            text NOT NULL,
  entity_code          text NOT NULL,
  region               text NOT NULL,
  chart_code           text NOT NULL,
  account_number       text NOT NULL,
  period               date NOT NULL,
  transaction_currency text NOT NULL,
  functional_currency  text NOT NULL,
  currency_pair        text NOT NULL,
  currency1            text NOT NULL,
  currency2            text NOT NULL,
  pair_rate            numeric(28,10) NOT NULL,
  amount               numeric(28,4) NOT NULL,
  amount1              numeric(28,4) NOT NULL,
  amount2              numeric(28,4) NOT NULL,
  dimensions           jsonb NOT NULL,
  PRIMARY KEY (tenant_id, run_id, row_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES exposure_analysis.runs (tenant_id, run_id)
);

-- program-scoped
CREATE TABLE exposure_analysis.exposure_groups (
  tenant_id         uuid NOT NULL,
  program_id        text NOT NULL,
  run_id            uuid NOT NULL,
  group_no          integer NOT NULL,
  netting_level     text NOT NULL,
  region            text,
  entity_code       text,
  currency_pair     text NOT NULL,
  currency1         text NOT NULL,
  currency2         text NOT NULL,
  exposure_currency text NOT NULL,
  period            date NOT NULL,
  row_count         integer NOT NULL,
  long1             numeric(28,4) NOT NULL,
  short1            numeric(28,4) NOT NULL,
  net1              numeric(28,4) NOT NULL,
  net2              numeric(28,4) NOT NULL,
  exposure_amount   numeric(28,4) NOT NULL,
  display_currency  text NOT NULL,
  display_rate      numeric(28,10) NOT NULL,
  display_amount    numeric(28,4) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, group_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES exposure_analysis.runs (tenant_id, run_id)
);

-- program-scoped
CREATE TABLE exposure_analysis.group_members (
  tenant_id   uuid NOT NULL,
  program_id  text NOT NULL,
  run_id      uuid NOT NULL,
  group_no    integer NOT NULL,
  row_no      integer NOT NULL,
  amount1     numeric(28,4) NOT NULL,
  amount2     numeric(28,4) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, group_no, row_no),
  FOREIGN KEY (tenant_id, run_id, group_no) REFERENCES exposure_analysis.exposure_groups (tenant_id, run_id, group_no),
  FOREIGN KEY (tenant_id, run_id, row_no) REFERENCES exposure_analysis.baseline_rows (tenant_id, run_id, row_no)
);

-- program-scoped
CREATE TABLE exposure_analysis.rates_used (
  tenant_id   uuid NOT NULL,
  program_id  text NOT NULL,
  run_id      uuid NOT NULL,
  base        text NOT NULL,
  quote       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('PAIR', 'DISPLAY', 'PORTFOLIO')),
  rate        numeric(28,10) NOT NULL,
  quality     text NOT NULL,
  derivation  text NOT NULL,
  source      text,
  load_ids    jsonb NOT NULL,
  PRIMARY KEY (tenant_id, run_id, base, quote, purpose),
  FOREIGN KEY (tenant_id, run_id) REFERENCES exposure_analysis.runs (tenant_id, run_id)
);

CREATE TABLE exposure_analysis.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  published_at  timestamptz
);
CREATE UNIQUE INDEX outbox_seq ON exposure_analysis.outbox (seq);
CREATE INDEX outbox_unpublished ON exposure_analysis.outbox (created_at) WHERE published_at IS NULL;
