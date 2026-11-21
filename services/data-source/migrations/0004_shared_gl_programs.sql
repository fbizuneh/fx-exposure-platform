-- One financial balance can belong to two balance-sheet programs (decision 0027).
-- program-scoped
CREATE TABLE data_source.balance_programs (
  tenant_id        uuid NOT NULL,
  balance_id       uuid NOT NULL,
  program_id       text NOT NULL,
  matched_rule_ids jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, balance_id, program_id),
  FOREIGN KEY (tenant_id, balance_id) REFERENCES data_source.balances (tenant_id, balance_id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES data_source.programs (tenant_id, program_id)
);
INSERT INTO data_source.balance_programs (tenant_id, balance_id, program_id, matched_rule_ids)
SELECT tenant_id, balance_id, program_id, matched_rule_ids
FROM data_source.balances WHERE outcome = 'INCLUDED' AND program_id IS NOT NULL;
CREATE INDEX balance_programs_by_program ON data_source.balance_programs (tenant_id, program_id, balance_id);

DROP INDEX data_source.balances_included;
ALTER TABLE data_source.balances DROP CONSTRAINT balances_check;
ALTER TABLE data_source.balances DROP COLUMN program_id;
ALTER TABLE data_source.balances ADD CONSTRAINT balances_included_facts
  CHECK (outcome <> 'INCLUDED' OR (amount IS NOT NULL AND entity_id IS NOT NULL AND account_id IS NOT NULL AND currency IS NOT NULL));
