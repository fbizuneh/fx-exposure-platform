-- Decision 0014: a business-day calendar per currency, versioned like the rest of master data. One row is one currency's calendar:
-- its weekend days, the holidays loaded, and the date those holidays are known through (beyond it the calendar is not trusted).
CREATE TABLE master_data.calendars (
  tenant_id       uuid NOT NULL,
  calendar_id     uuid NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date,
  source_system   text NOT NULL,
  code            text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  weekend_days    text[] NOT NULL,
  covered_through date NOT NULL,
  holidays        jsonb NOT NULL,
  batch_id        uuid NOT NULL,
  PRIMARY KEY (tenant_id, calendar_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, calendar_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, code WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
ALTER TABLE master_data.change_sets DROP CONSTRAINT change_sets_kind_check;
ALTER TABLE master_data.change_sets ADD CONSTRAINT change_sets_kind_check CHECK (kind IN ('ENTITY', 'HIERARCHY', 'ACCOUNT', 'CURRENCY', 'CALENDAR'));
