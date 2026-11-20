-- Decision 0020: the amount-threshold strategy. A program picks its strategy; the threshold is in the display currency with an override per netting level.
ALTER TABLE hedge_recommendation.policies ADD COLUMN strategy text NOT NULL DEFAULT 'hedge-ratio-adjustment' CHECK (strategy IN ('hedge-ratio-adjustment', 'amount-threshold'));
ALTER TABLE hedge_recommendation.policies ADD COLUMN amount_threshold_display numeric(28,4) CHECK (amount_threshold_display IS NULL OR amount_threshold_display > 0);
ALTER TABLE hedge_recommendation.policies ADD CONSTRAINT policies_threshold_for_strategy CHECK (strategy <> 'amount-threshold' OR amount_threshold_display IS NOT NULL);

-- program-scoped
CREATE TABLE hedge_recommendation.amount_threshold_overrides (
  tenant_id                uuid NOT NULL,
  program_id               text NOT NULL,
  netting_level            text NOT NULL,
  amount_threshold_display numeric(28,4) NOT NULL CHECK (amount_threshold_display > 0),
  PRIMARY KEY (tenant_id, program_id, netting_level),
  FOREIGN KEY (tenant_id, program_id) REFERENCES hedge_recommendation.policies (tenant_id, program_id)
);

-- A recommendation from the amount-threshold strategy has no ratio; it keeps the threshold it was compared with, in the exposure currency.
ALTER TABLE hedge_recommendation.recommendations ALTER COLUMN ratio DROP NOT NULL;
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN threshold_exposure_amount numeric(28,4);
