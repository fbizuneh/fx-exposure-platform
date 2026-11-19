-- Decision 0008: per-program overrides of the default exposure currency of a netted pair.
ALTER TABLE exposure_management.program_settings ADD COLUMN exposure_currency_overrides jsonb NOT NULL DEFAULT '[]';
UPDATE exposure_management.cycles SET settings = settings || '{"exposureCurrencyOverrides":[]}'::jsonb WHERE NOT settings ? 'exposureCurrencyOverrides';
