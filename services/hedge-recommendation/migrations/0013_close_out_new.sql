-- Decision 0022: the roll type Close-out+New. The maturing hedges are closed and the new hedges are what the rule gives on the hedges that remain; the new trades are parts with the role NEW.
ALTER TABLE hedge_recommendation.policies DROP CONSTRAINT policies_roll_type_check;
ALTER TABLE hedge_recommendation.policies ADD CONSTRAINT policies_roll_type_check CHECK (roll_type IN ('NONE', 'ADJUST_SWAP', 'CLOSE_OUT_NEW'));
ALTER TABLE hedge_recommendation.recommendations DROP CONSTRAINT recommendations_roll_type_check;
ALTER TABLE hedge_recommendation.recommendations ADD CONSTRAINT recommendations_roll_type_check CHECK (roll_type IS NULL OR roll_type IN ('ADJUST_SWAP', 'CLOSE_OUT_NEW'));
ALTER TABLE hedge_recommendation.recommendation_parts DROP CONSTRAINT recommendation_parts_role_check;
ALTER TABLE hedge_recommendation.recommendation_parts ADD CONSTRAINT recommendation_parts_role_check CHECK (role IN ('ADJUSTMENT', 'CLOSE_OUT', 'ROLL', 'COMBINED', 'NEW'));
