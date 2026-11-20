-- Decision 0016: a maximum hedge amount (display currency) per program with an override per netting level, and a split of a larger recommendation into parts.
ALTER TABLE hedge_recommendation.policies ADD COLUMN max_hedge_display numeric(28,4) CHECK (max_hedge_display IS NULL OR max_hedge_display > 0);
ALTER TABLE hedge_recommendation.policies ADD COLUMN split_method text NOT NULL DEFAULT 'EVEN' CHECK (split_method IN ('EVEN', 'THRESHOLD_REMAINDER'));

-- program-scoped
CREATE TABLE hedge_recommendation.max_hedge_overrides (
  tenant_id         uuid NOT NULL,
  program_id        text NOT NULL,
  netting_level     text NOT NULL,
  max_hedge_display numeric(28,4) NOT NULL CHECK (max_hedge_display > 0),
  PRIMARY KEY (tenant_id, program_id, netting_level)
);

-- What the split used, kept with the recommendation so an override can be split the same way.
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN max_exposure_amount numeric(28,4);
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN split_method text CHECK (split_method IN ('EVEN', 'THRESHOLD_REMAINDER'));
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN split_note text;

-- The parts of a hedge recommendation: one part, or several when the amount is above the maximum. Each part becomes one pre-trade in FX Trade.
-- program-scoped
CREATE TABLE hedge_recommendation.recommendation_parts (
  tenant_id         uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  program_id        text NOT NULL,
  part_no           integer NOT NULL CHECK (part_no >= 1),
  amount            numeric(28,4) NOT NULL CHECK (amount > 0),
  pre_trade_id      uuid,
  follow_up         text NOT NULL DEFAULT 'NOT_STARTED' CHECK (follow_up IN ('NOT_STARTED', 'OPEN', 'PARTLY_EXECUTED', 'EXECUTED', 'CANCELLED')),
  PRIMARY KEY (tenant_id, recommendation_id, part_no)
);
CREATE INDEX recommendation_parts_pre_trade ON hedge_recommendation.recommendation_parts (tenant_id, pre_trade_id);

-- Every existing hedge recommendation becomes one part, carrying its pre-trade and follow-up.
INSERT INTO hedge_recommendation.recommendation_parts (tenant_id, recommendation_id, program_id, part_no, amount, pre_trade_id, follow_up)
SELECT tenant_id, recommendation_id, program_id, 1, COALESCE(decided_amount, amount), pre_trade_id, follow_up
FROM hedge_recommendation.recommendations WHERE action = 'HEDGE' AND amount IS NOT NULL;

DROP INDEX hedge_recommendation.recommendations_pre_trade;
ALTER TABLE hedge_recommendation.recommendations DROP COLUMN pre_trade_id;
