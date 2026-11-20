-- Hedge Recommendation: policy, recommendations and decisions. Every table carries tenant_id.

-- program-scoped
CREATE TABLE hedge_recommendation.policies (
  tenant_id            uuid NOT NULL,
  program_id           text NOT NULL,
  default_ratio        numeric(9,6) NOT NULL CHECK (default_ratio >= 0),
  min_hedge_display    numeric(28,4) NOT NULL CHECK (min_hedge_display >= 0),
  rounding_default     numeric(28,4) NOT NULL CHECK (rounding_default > 0),
  tenor                text NOT NULL,
  trading_entity_code  text,
  updated_by           text NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, program_id)
);

-- program-scoped
CREATE TABLE hedge_recommendation.ratio_overrides (
  tenant_id     uuid NOT NULL,
  program_id    text NOT NULL,
  currency_pair text NOT NULL,
  ratio         numeric(9,6) NOT NULL CHECK (ratio >= 0),
  PRIMARY KEY (tenant_id, program_id, currency_pair)
);

-- program-scoped
CREATE TABLE hedge_recommendation.rounding_overrides (
  tenant_id  uuid NOT NULL,
  program_id text NOT NULL,
  currency   text NOT NULL,
  rounding   numeric(28,4) NOT NULL CHECK (rounding > 0),
  PRIMARY KEY (tenant_id, program_id, currency)
);

-- program-scoped
CREATE TABLE hedge_recommendation.recommendations (
  tenant_id           uuid NOT NULL,
  recommendation_id   uuid NOT NULL,
  program_id          text NOT NULL,
  cycle_id            uuid NOT NULL,
  run_id              uuid NOT NULL,
  strategy            text NOT NULL,
  group_no            integer NOT NULL,
  netting_level       text NOT NULL,
  region              text,
  entity_code         text,
  currency_pair       text NOT NULL,
  exposure_currency   text NOT NULL,
  other_currency      text NOT NULL,
  trading_entity_code text,
  gross_exposure      numeric(28,4) NOT NULL,
  hedged_amount       numeric(28,4) NOT NULL,
  ratio               numeric(9,6) NOT NULL,
  target_hedge        numeric(28,4) NOT NULL,
  needed_amount       numeric(28,4) NOT NULL,
  rounding            numeric(28,4) NOT NULL,
  min_exposure_amount numeric(28,4),
  action              text NOT NULL CHECK (action IN ('HEDGE', 'NONE')),
  reason              text,
  direction           text CHECK (direction IN ('BUY', 'SELL')),
  amount              numeric(28,4),
  instrument          text CHECK (instrument IN ('FORWARD', 'NDF')),
  value_date          date,
  fixing_date         date,
  status              text NOT NULL CHECK (status IN ('OPEN', 'DECIDING', 'ACCEPTED', 'OVERRIDDEN', 'DISMISSED', 'LAPSED', 'SUPERSEDED', 'NONE')),
  decision_kind       text CHECK (decision_kind IN ('ACCEPT', 'OVERRIDE')),
  decided_amount      numeric(28,4),
  decided_by          text,
  decided_at          timestamptz,
  decision_note       text,
  pre_trade_id        uuid,
  follow_up           text NOT NULL DEFAULT 'NOT_STARTED' CHECK (follow_up IN ('NOT_STARTED', 'OPEN', 'PARTLY_EXECUTED', 'EXECUTED', 'CANCELLED')),
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, recommendation_id)
);
CREATE INDEX recommendations_cycle ON hedge_recommendation.recommendations (tenant_id, cycle_id);
CREATE INDEX recommendations_pre_trade ON hedge_recommendation.recommendations (tenant_id, pre_trade_id);

-- events already handled, so a delivery twice changes nothing
CREATE TABLE hedge_recommendation.processed_events (
  tenant_id  uuid NOT NULL,
  event_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE hedge_recommendation.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  published_at  timestamptz
);
CREATE UNIQUE INDEX outbox_seq ON hedge_recommendation.outbox (seq);
