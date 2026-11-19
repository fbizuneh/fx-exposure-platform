-- Decision 0008: a currency reference, versioned like the rest of master data. For now it records which currencies trade as NDF.
CREATE TABLE master_data.currencies (
  tenant_id      uuid NOT NULL,
  currency_id    uuid NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date,
  source_system  text NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  is_ndf         boolean NOT NULL,
  batch_id       uuid NOT NULL,
  PRIMARY KEY (tenant_id, currency_id, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (tenant_id WITH =, currency_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&),
  EXCLUDE USING gist (tenant_id WITH =, code WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
ALTER TABLE master_data.change_sets DROP CONSTRAINT change_sets_kind_check;
ALTER TABLE master_data.change_sets ADD CONSTRAINT change_sets_kind_check CHECK (kind IN ('ENTITY', 'HIERARCHY', 'ACCOUNT', 'CURRENCY'));
