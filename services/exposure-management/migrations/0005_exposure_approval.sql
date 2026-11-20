-- Approve Exposure (decision 0011): a gate after the run completes and before the cycle is approved. It locks the exact completed run.
ALTER TABLE exposure_management.cycles ADD COLUMN exposure_approved_at timestamptz;
ALTER TABLE exposure_management.cycles ADD COLUMN exposure_approved_by text;
ALTER TABLE exposure_management.cycles ADD COLUMN exposure_approved_run_id text;
ALTER TABLE exposure_management.cycles ADD CONSTRAINT cycles_exposure_approval_complete
  CHECK ((exposure_approved_at IS NULL) = (exposure_approved_by IS NULL) AND (exposure_approved_at IS NULL) = (exposure_approved_run_id IS NULL));
ALTER TABLE exposure_management.cycles ADD CONSTRAINT cycles_exposure_approval_completed_only
  CHECK (exposure_approved_at IS NULL OR (stage = 'COMPLETED' AND outcome IS NULL));
-- a cycle is approved only after its exposure is
ALTER TABLE exposure_management.cycles ADD CONSTRAINT cycles_exposure_before_cycle
  CHECK (approved_at IS NULL OR exposure_approved_at IS NOT NULL);
ALTER TABLE exposure_management.cycle_history DROP CONSTRAINT IF EXISTS cycle_history_kind_check;
ALTER TABLE exposure_management.cycle_history ADD CONSTRAINT cycle_history_kind_check
  CHECK (kind IN ('INITIATED', 'RUN_STARTED', 'RUN_FINISHED', 'RERUN', 'SKIPPED', 'DELETED', 'EXPOSURE_APPROVED', 'APPROVED'));
