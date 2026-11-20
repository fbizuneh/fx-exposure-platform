-- Decision 0015: which currency of a pair is the exposure currency, per hedging program, versioned like the rest of master data.
-- program-scoped
CREATE TABLE master_data.pair_exposure_currencies (
  tenant_id          uuid NOT NULL,
  mapping_id         uuid NOT NULL,
  valid_from         date NOT NULL,
  valid_to           date,
  source_system      text NOT NULL,
  program_id         text NOT NULL,
  pair               text NOT NULL CHECK (pair ~ '^[A-Z]{3}-[A-Z]{3}$' AND split_part(pair, '-', 1) < split_part(pair, '-', 2)),
  exposure_currency  text NOT NULL CHECK (exposure_currency ~ '^[A-Z]{3}$'),
  batch_id           uuid NOT NULL,
  PRIMARY KEY (tenant_id, mapping_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (exposure_currency = split_part(pair, '-', 1) OR exposure_currency = split_part(pair, '-', 2)),
  EXCLUDE USING gist (tenant_id WITH =, mapping_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, program_id WITH =, pair WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
ALTER TABLE master_data.change_sets DROP CONSTRAINT change_sets_kind_check;
ALTER TABLE master_data.change_sets ADD CONSTRAINT change_sets_kind_check CHECK (kind IN ('ENTITY', 'HIERARCHY', 'ACCOUNT', 'CURRENCY', 'CALENDAR', 'EXPOSURE_CURRENCY'));

-- A change set of mappings is for one hedging program: its snapshot key, its omissions and its safeguard count are that program's alone.
ALTER TABLE master_data.change_sets ADD COLUMN scope_key text NOT NULL DEFAULT '';
DROP INDEX master_data.change_sets_snapshot_key;
CREATE UNIQUE INDEX change_sets_snapshot_key
  ON master_data.change_sets (tenant_id, source_system, kind, scope_key, as_of)
  WHERE mode = 'SNAPSHOT' AND status <> 'REJECTED';
