-- Decision 0016: one recommendation can have several pre-trades (a split hedge). Each is a numbered part of its recommendation.
ALTER TABLE fx_trade.pre_trades ADD COLUMN part_no integer;
UPDATE fx_trade.pre_trades SET part_no = 1 WHERE recommendation_id IS NOT NULL;
ALTER TABLE fx_trade.pre_trades ADD CONSTRAINT pre_trades_part_with_recommendation CHECK ((recommendation_id IS NULL) = (part_no IS NULL) AND (part_no IS NULL OR part_no >= 1));
DROP INDEX fx_trade.pre_trades_recommendation;
CREATE UNIQUE INDEX pre_trades_recommendation ON fx_trade.pre_trades (tenant_id, recommendation_id, part_no) WHERE recommendation_id IS NOT NULL;
