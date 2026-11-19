-- FX Rate schema, first migration (docs/decisions/0005). Every table carries tenant_id.
-- Rates are append-only: a new load adds rows, nothing is updated. A lookup picks the latest valid one.

CREATE SCHEMA IF NOT EXISTS fx_rate;

CREATE TABLE fx_rate.tenant_settings (
  tenant_id         uuid PRIMARY KEY,
  preferred_source  text,
  pivot_currency    text NOT NULL DEFAULT 'USD' CHECK (pivot_currency ~ '^[A-Z]{3}$'),
  outlier_share     numeric(4, 3) NOT NULL DEFAULT 0.100 CHECK (outlier_share > 0 AND outlier_share <= 1),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fx_rate.rate_sources (
  tenant_id            uuid NOT NULL,
  source_code          text NOT NULL,
  stale_after_minutes  integer CHECK (stale_after_minutes IS NULL OR stale_after_minutes > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_code)
);

CREATE TABLE fx_rate.rate_loads (
  tenant_id      uuid NOT NULL,
  load_id        uuid NOT NULL,
  source_code    text NOT NULL,
  business_date  date NOT NULL,
  content_hash   text NOT NULL,
  row_count      integer NOT NULL,
  warning_count  integer NOT NULL,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, load_id),
  UNIQUE (tenant_id, source_code, business_date, content_hash)
);

CREATE TABLE fx_rate.rates (
  tenant_id        uuid NOT NULL,
  rate_id          uuid NOT NULL,
  load_id          uuid NOT NULL,
  source_code      text NOT NULL,
  business_date    date NOT NULL,
  base_currency    text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency   text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate_type        text NOT NULL CHECK (rate_type IN ('SPOT', 'FORWARD')),
  tenor            text NOT NULL,
  value_date       date,
  all_in_rate      numeric(20, 10) NOT NULL CHECK (all_in_rate > 0),
  spot_rate        numeric(20, 10) CHECK (spot_rate > 0),
  forward_points   numeric(20, 10),
  bid              numeric(20, 10) CHECK (bid > 0),
  mid              numeric(20, 10) CHECK (mid > 0),
  ask              numeric(20, 10) CHECK (ask > 0),
  observed_at      timestamptz NOT NULL,
  quality          text NOT NULL CHECK (quality IN ('VALID', 'STALE', 'OUTLIER')),
  loaded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rate_id),
  CHECK (base_currency <> quote_currency),
  CHECK ((rate_type = 'SPOT') = (tenor = 'SPOT')),
  FOREIGN KEY (tenant_id, load_id) REFERENCES fx_rate.rate_loads (tenant_id, load_id),
  UNIQUE (tenant_id, load_id, base_currency, quote_currency, tenor)
);
CREATE INDEX rates_lookup ON fx_rate.rates (tenant_id, business_date, base_currency, quote_currency, tenor, loaded_at DESC);

CREATE TABLE fx_rate.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
