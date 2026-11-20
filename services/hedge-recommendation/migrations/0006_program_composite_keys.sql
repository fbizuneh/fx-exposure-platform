-- Composite keys that carry the program (decision 0018): a part belongs to its recommendation's program, and a policy's overrides to the policy's.
ALTER TABLE hedge_recommendation.recommendations ADD CONSTRAINT recommendations_recommendation_program_key UNIQUE (tenant_id, recommendation_id, program_id);
ALTER TABLE hedge_recommendation.recommendation_parts ADD FOREIGN KEY (tenant_id, recommendation_id, program_id) REFERENCES hedge_recommendation.recommendations (tenant_id, recommendation_id, program_id);
ALTER TABLE hedge_recommendation.ratio_overrides ADD FOREIGN KEY (tenant_id, program_id) REFERENCES hedge_recommendation.policies (tenant_id, program_id);
ALTER TABLE hedge_recommendation.rounding_overrides ADD FOREIGN KEY (tenant_id, program_id) REFERENCES hedge_recommendation.policies (tenant_id, program_id);
ALTER TABLE hedge_recommendation.max_hedge_overrides ADD FOREIGN KEY (tenant_id, program_id) REFERENCES hedge_recommendation.policies (tenant_id, program_id);
