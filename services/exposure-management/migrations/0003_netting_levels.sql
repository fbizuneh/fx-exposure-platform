-- Decision 0008: six-way netting choice replaces the first three names, and each program gets a display currency.
ALTER TABLE exposure_management.program_settings DROP CONSTRAINT IF EXISTS program_settings_netting_level_check;
UPDATE exposure_management.program_settings SET netting_level = CASE netting_level
  WHEN 'ENTITY_PAIR' THEN 'ENTITY' WHEN 'CORPORATE_PAIR' THEN 'GROUP_NATURAL' WHEN 'REGION_PAIR' THEN 'REGION' ELSE netting_level END;
ALTER TABLE exposure_management.program_settings ADD CONSTRAINT program_settings_netting_level_check
  CHECK (netting_level IN ('GROUP_NATURAL', 'GROUP_PORTFOLIO', 'REGION', 'REGION_BY_ENTITY', 'ENTITY'));
ALTER TABLE exposure_management.program_settings ADD COLUMN display_currency text NOT NULL DEFAULT 'USD' CHECK (display_currency ~ '^[A-Z]{3}$');
-- A cycle keeps a copy of the settings it ran with: bring those copies in line.
UPDATE exposure_management.cycles SET settings = jsonb_set(settings || '{"displayCurrency":"USD"}'::jsonb, '{nettingLevel}',
  to_jsonb(CASE settings->>'nettingLevel' WHEN 'ENTITY_PAIR' THEN 'ENTITY' WHEN 'CORPORATE_PAIR' THEN 'GROUP_NATURAL' WHEN 'REGION_PAIR' THEN 'REGION' ELSE settings->>'nettingLevel' END));
