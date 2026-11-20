-- Decision 0021: a hedge row says when its leg matures, which net group it fell in and its amount in that group's exposure currency, so a roll can pick the maturing legs
-- of each group. Rows of runs made before this have none of the three.
ALTER TABLE exposure_analysis.hedge_rows ADD COLUMN value_date date;
ALTER TABLE exposure_analysis.hedge_rows ADD COLUMN group_no integer;
ALTER TABLE exposure_analysis.hedge_rows ADD COLUMN exposure_amount numeric(28,4);
