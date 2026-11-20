-- Decision 0021, third review of PR 14: the roll dates a run finished with. When the dates are edited after a run has finished, this keeps the dates that run
-- finished with, so recommendations made from its (late) "run finished" event use them, and the approval then sees they are not the current dates.
-- program-scoped
CREATE TABLE hedge_recommendation.roll_run_bindings (
  tenant_id   uuid NOT NULL,
  program_id  text NOT NULL,
  cycle_id    uuid NOT NULL,
  run_id      uuid NOT NULL,
  revision    integer,
  near_date   date,
  far_date    date,
  offset_days integer,
  PRIMARY KEY (tenant_id, program_id, cycle_id, run_id)
);
