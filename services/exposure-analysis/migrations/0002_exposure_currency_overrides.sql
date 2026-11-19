-- Decision 0008: the program's exposure currency overrides, copied from the cycle's settings when the run is saved.
ALTER TABLE exposure_analysis.runs ADD COLUMN exposure_currency_overrides jsonb NOT NULL DEFAULT '[]';
