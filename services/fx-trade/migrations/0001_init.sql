-- FX Trade: pre-trades out, executed trades in. Every table carries tenant_id.
CREATE TABLE fx_trade.pre_trades (
  tenant_id            uuid NOT NULL,
  pre_trade_id         uuid NOT NULL,
  reference            text NOT NULL,
  program_id           text NOT NULL,
  cycle_id             uuid,
  recommendation_id    text,
  origin               text NOT NULL CHECK (origin IN ('RECOMMENDATION', 'MANUAL')),
  status               text NOT NULL CHECK (status IN ('DRAFT', 'READY', 'SENT', 'PARTLY_EXECUTED', 'EXECUTED', 'CANCELLED')),
  trading_entity_code  text NOT NULL,
  instrument           text NOT NULL CHECK (instrument IN ('SPOT', 'FORWARD', 'NDF', 'SWAP')),
  released_at          timestamptz,
  sent_at              timestamptz,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pre_trade_id),
  UNIQUE (tenant_id, reference)
);
CREATE UNIQUE INDEX pre_trades_recommendation ON fx_trade.pre_trades (tenant_id, recommendation_id) WHERE recommendation_id IS NOT NULL;
CREATE INDEX pre_trades_cycle ON fx_trade.pre_trades (tenant_id, cycle_id);
CREATE INDEX pre_trades_program ON fx_trade.pre_trades (tenant_id, program_id, status);

CREATE TABLE fx_trade.pre_trade_legs (
  tenant_id            uuid NOT NULL,
  pre_trade_id         uuid NOT NULL,
  leg_no               integer NOT NULL,
  leg_role             text NOT NULL CHECK (leg_role IN ('SINGLE', 'NEAR', 'FAR')),
  direction            text NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  deal_currency        text NOT NULL,
  deal_amount          numeric(28, 4) NOT NULL CHECK (deal_amount > 0),
  settlement_currency  text NOT NULL,
  settlement_amount    numeric(28, 4) CHECK (settlement_amount > 0),
  value_date           date NOT NULL,
  fixing_date          date,
  PRIMARY KEY (tenant_id, pre_trade_id, leg_no),
  FOREIGN KEY (tenant_id, pre_trade_id) REFERENCES fx_trade.pre_trades (tenant_id, pre_trade_id),
  CHECK (deal_currency <> settlement_currency)
);

CREATE TABLE fx_trade.trade_batches (
  tenant_id     uuid NOT NULL,
  batch_id      uuid NOT NULL,
  content_hash  text NOT NULL,
  received      integer NOT NULL,
  stored        integer NOT NULL,
  unchanged     integer NOT NULL,
  blocked       integer NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id),
  UNIQUE (tenant_id, content_hash)
);

CREATE TABLE fx_trade.executed_trades (
  tenant_id            uuid NOT NULL,
  executed_trade_id    uuid NOT NULL,
  platform             text NOT NULL,
  trade_id             text NOT NULL,
  version              integer NOT NULL,
  is_current           boolean NOT NULL,
  cancelled            boolean NOT NULL DEFAULT false,
  content_hash         text NOT NULL,
  batch_id             uuid,
  program_id           text,
  trading_entity_code  text NOT NULL,
  counterparty         text,
  trade_date           date NOT NULL,
  instrument           text NOT NULL CHECK (instrument IN ('SPOT', 'FORWARD', 'NDF', 'SWAP')),
  portfolio            text,
  custom_fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
  pre_trade_reference  text,
  pre_trade_id         uuid,
  match_status         text NOT NULL CHECK (match_status IN ('MATCHED', 'UNMATCHED', 'AMBIGUOUS')),
  match_note           text,
  candidates           jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, executed_trade_id),
  UNIQUE (tenant_id, platform, trade_id, version),
  FOREIGN KEY (tenant_id, pre_trade_id) REFERENCES fx_trade.pre_trades (tenant_id, pre_trade_id),
  CHECK ((match_status = 'MATCHED') = (pre_trade_id IS NOT NULL))
);
CREATE UNIQUE INDEX executed_trades_current ON fx_trade.executed_trades (tenant_id, platform, trade_id) WHERE is_current;
CREATE INDEX executed_trades_program ON fx_trade.executed_trades (tenant_id, program_id, trade_date);
CREATE INDEX executed_trades_pre ON fx_trade.executed_trades (tenant_id, pre_trade_id) WHERE pre_trade_id IS NOT NULL;

CREATE TABLE fx_trade.executed_trade_legs (
  tenant_id            uuid NOT NULL,
  executed_trade_id    uuid NOT NULL,
  leg_no               integer NOT NULL,
  leg_role             text NOT NULL CHECK (leg_role IN ('SINGLE', 'NEAR', 'FAR')),
  direction            text NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  deal_currency        text NOT NULL,
  deal_amount          numeric(28, 4) NOT NULL CHECK (deal_amount > 0),
  settlement_currency  text NOT NULL,
  settlement_amount    numeric(28, 4) NOT NULL CHECK (settlement_amount > 0),
  value_date           date NOT NULL,
  fixing_date          date,
  PRIMARY KEY (tenant_id, executed_trade_id, leg_no),
  FOREIGN KEY (tenant_id, executed_trade_id) REFERENCES fx_trade.executed_trades (tenant_id, executed_trade_id),
  CHECK (deal_currency <> settlement_currency)
);

CREATE TABLE fx_trade.trade_issues (
  tenant_id   uuid NOT NULL,
  issue_id    uuid NOT NULL,
  batch_id    uuid NOT NULL,
  row_no      integer NOT NULL,
  code        text NOT NULL,
  message     text NOT NULL,
  raw         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, issue_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES fx_trade.trade_batches (tenant_id, batch_id)
);

CREATE TABLE fx_trade.handled_events (
  tenant_id  uuid NOT NULL,
  event_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE fx_trade.outbox (
  event_id      uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  published_at  timestamptz
);
CREATE UNIQUE INDEX outbox_seq ON fx_trade.outbox (seq);
