-- Net exposure (docs/decisions/0010): outstanding hedge rows and the gross/hedge/net figures per netting group.
ALTER TABLE exposure_analysis.runs ADD COLUMN hedge_counts jsonb;

-- program-scoped: one row per open hedge leg used by the run
CREATE TABLE exposure_analysis.hedge_rows (
  tenant_id          uuid NOT NULL,
  program_id         text NOT NULL,
  run_id             uuid NOT NULL,
  row_no             integer NOT NULL,
  executed_trade_id  text NOT NULL,
  platform           text NOT NULL,
  trade_id           text NOT NULL,
  leg_no             integer NOT NULL,
  entity_code        text NOT NULL,
  region             text NOT NULL,
  period             date NOT NULL,
  deal_currency      text NOT NULL,
  settlement_currency text NOT NULL,
  currency_pair      text NOT NULL,
  currency1          text NOT NULL,
  currency2          text NOT NULL,
  amount1            numeric(28,4) NOT NULL,
  amount2            numeric(28,4) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, row_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES exposure_analysis.runs (tenant_id, run_id)
);

-- program-scoped: net exposure per netting group (gross, hedges, net)
CREATE TABLE exposure_analysis.net_groups (
  tenant_id            uuid NOT NULL,
  program_id           text NOT NULL,
  run_id               uuid NOT NULL,
  group_no             integer NOT NULL,
  netting_level        text NOT NULL,
  region               text,
  entity_code          text,
  currency_pair        text NOT NULL,
  currency1            text NOT NULL,
  currency2            text NOT NULL,
  exposure_currency    text NOT NULL,
  period               date NOT NULL,
  display_currency     text NOT NULL,
  display_rate         numeric(28,10) NOT NULL,
  gross_net1           numeric(28,4) NOT NULL,
  gross_net2           numeric(28,4) NOT NULL,
  gross_exposure       numeric(28,4) NOT NULL,
  gross_display        numeric(28,4) NOT NULL,
  hedge_net1           numeric(28,4) NOT NULL,
  hedge_net2           numeric(28,4) NOT NULL,
  hedge_exposure       numeric(28,4) NOT NULL,
  hedge_display        numeric(28,4) NOT NULL,
  net_net1             numeric(28,4) NOT NULL,
  net_net2             numeric(28,4) NOT NULL,
  net_exposure         numeric(28,4) NOT NULL,
  net_display          numeric(28,4) NOT NULL,
  PRIMARY KEY (tenant_id, run_id, group_no),
  FOREIGN KEY (tenant_id, run_id) REFERENCES exposure_analysis.runs (tenant_id, run_id)
);
