-- Decision 0021, review of PR 14.
-- Roll dates carry a revision, and a recommendation keeps the revision it was made from; Approve Exposure is refused while they differ, and the dates are locked for the run it approves.
ALTER TABLE hedge_recommendation.roll_parameters ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_revision integer;
-- program-scoped
CREATE TABLE hedge_recommendation.roll_locks (
  tenant_id  uuid NOT NULL,
  program_id text NOT NULL,
  cycle_id   uuid NOT NULL,
  run_id     uuid NOT NULL,
  locked_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, program_id, cycle_id)
);
-- A close-out is booked by the entity that holds the maturing hedge, which is not always the recommendation's entity. Empty: the recommendation's.
ALTER TABLE hedge_recommendation.recommendation_parts ADD COLUMN trading_entity_code text;
-- An entered far date that is closed for a currency of the group's pair: the date, the currencies and the next joint business day.
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_issue jsonb;
