-- Decision 0014: the currencies whose business-day calendar was missing or too short when a recommendation's dates were worked out.
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN calendar_gaps jsonb NOT NULL DEFAULT '[]';
