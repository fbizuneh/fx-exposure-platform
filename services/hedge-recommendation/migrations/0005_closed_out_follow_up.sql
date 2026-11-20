-- A split recommendation whose parts are all either executed or cancelled, with at least one of each, is closed out (decision 0017): its own follow-up status.
-- Parts never take it: a part is executed or cancelled, not both.
ALTER TABLE hedge_recommendation.recommendations DROP CONSTRAINT IF EXISTS recommendations_follow_up_check;
ALTER TABLE hedge_recommendation.recommendations ADD CONSTRAINT recommendations_follow_up_check
  CHECK (follow_up IN ('NOT_STARTED', 'OPEN', 'PARTLY_EXECUTED', 'EXECUTED', 'EXECUTED_REST_CANCELLED', 'CANCELLED'));
UPDATE hedge_recommendation.recommendations r SET follow_up = 'EXECUTED_REST_CANCELLED'
WHERE r.follow_up = 'PARTLY_EXECUTED'
  AND EXISTS (SELECT 1 FROM hedge_recommendation.recommendation_parts p WHERE p.tenant_id = r.tenant_id AND p.recommendation_id = r.recommendation_id AND p.follow_up = 'EXECUTED')
  AND NOT EXISTS (SELECT 1 FROM hedge_recommendation.recommendation_parts p WHERE p.tenant_id = r.tenant_id AND p.recommendation_id = r.recommendation_id AND p.follow_up NOT IN ('EXECUTED', 'CANCELLED'));
