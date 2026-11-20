-- Composite keys that carry the program (decision 0018): a row under a run belongs to the run's program, by construction, not by the code's care.
ALTER TABLE exposure_analysis.runs ADD CONSTRAINT runs_run_program_key UNIQUE (tenant_id, run_id, program_id);
ALTER TABLE exposure_analysis.exposure_groups ADD CONSTRAINT exposure_groups_group_program_key UNIQUE (tenant_id, run_id, group_no, program_id);
ALTER TABLE exposure_analysis.baseline_rows ADD CONSTRAINT baseline_rows_row_program_key UNIQUE (tenant_id, run_id, row_no, program_id);

ALTER TABLE exposure_analysis.baseline_rows DROP CONSTRAINT baseline_rows_tenant_id_run_id_fkey;
ALTER TABLE exposure_analysis.baseline_rows ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES exposure_analysis.runs (tenant_id, run_id, program_id);
ALTER TABLE exposure_analysis.exposure_groups DROP CONSTRAINT exposure_groups_tenant_id_run_id_fkey;
ALTER TABLE exposure_analysis.exposure_groups ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES exposure_analysis.runs (tenant_id, run_id, program_id);
ALTER TABLE exposure_analysis.hedge_rows DROP CONSTRAINT hedge_rows_tenant_id_run_id_fkey;
ALTER TABLE exposure_analysis.hedge_rows ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES exposure_analysis.runs (tenant_id, run_id, program_id);
ALTER TABLE exposure_analysis.net_groups DROP CONSTRAINT net_groups_tenant_id_run_id_fkey;
ALTER TABLE exposure_analysis.net_groups ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES exposure_analysis.runs (tenant_id, run_id, program_id);
ALTER TABLE exposure_analysis.rates_used DROP CONSTRAINT rates_used_tenant_id_run_id_fkey;
ALTER TABLE exposure_analysis.rates_used ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES exposure_analysis.runs (tenant_id, run_id, program_id);

ALTER TABLE exposure_analysis.group_members DROP CONSTRAINT group_members_tenant_id_run_id_group_no_fkey;
ALTER TABLE exposure_analysis.group_members ADD FOREIGN KEY (tenant_id, run_id, group_no, program_id) REFERENCES exposure_analysis.exposure_groups (tenant_id, run_id, group_no, program_id);
ALTER TABLE exposure_analysis.group_members DROP CONSTRAINT group_members_tenant_id_run_id_row_no_fkey;
ALTER TABLE exposure_analysis.group_members ADD FOREIGN KEY (tenant_id, run_id, row_no, program_id) REFERENCES exposure_analysis.baseline_rows (tenant_id, run_id, row_no, program_id);
