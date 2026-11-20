-- Decision 0021, second review of PR 14: a lock on the roll dates belongs to the approval attempt that took it, so one attempt's cleanup cannot release another's.
ALTER TABLE hedge_recommendation.roll_locks ADD COLUMN attempt_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE hedge_recommendation.roll_locks DROP CONSTRAINT roll_locks_pkey;
ALTER TABLE hedge_recommendation.roll_locks ADD PRIMARY KEY (tenant_id, program_id, cycle_id, attempt_id);
