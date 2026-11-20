-- Decision 0015: the Master Data pair-to-exposure-currency mappings a run used, saved with it (the program's own overrides are in exposure_currency_overrides).
ALTER TABLE exposure_analysis.runs ADD COLUMN pair_mappings jsonb NOT NULL DEFAULT '[]';
