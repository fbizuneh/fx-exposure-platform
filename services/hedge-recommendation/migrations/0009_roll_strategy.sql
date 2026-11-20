-- Decision 0021: the roll-based strategy, Adjust+Swap. A program chooses a roll type and how the adjustment is booked; a cycle gets its roll dates entered.
ALTER TABLE hedge_recommendation.policies ADD COLUMN roll_type text NOT NULL DEFAULT 'NONE' CHECK (roll_type IN ('NONE', 'ADJUST_SWAP'));
ALTER TABLE hedge_recommendation.policies ADD COLUMN roll_adjustment text NOT NULL DEFAULT 'SEPARATE' CHECK (roll_adjustment IN ('SEPARATE', 'COMBINED'));
ALTER TABLE hedge_recommendation.policies ADD COLUMN roll_offset_days integer NOT NULL DEFAULT 0 CHECK (roll_offset_days >= 0);

-- The roll dates of one cycle, entered before its exposure is approved. A far date or offset left empty takes the policy's tenor date or default offset.
-- No foreign key to the policy: a policy is saved by replacing it, and the dates belong to the cycle.
-- program-scoped
CREATE TABLE hedge_recommendation.roll_parameters (
  tenant_id   uuid NOT NULL,
  program_id  text NOT NULL,
  cycle_id    uuid NOT NULL,
  near_date   date NOT NULL,
  far_date    date,
  offset_days integer CHECK (offset_days IS NULL OR offset_days >= 0),
  set_by      text NOT NULL,
  set_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, program_id, cycle_id),
  CHECK (far_date IS NULL OR far_date > near_date + COALESCE(offset_days, 0))
);

-- What a recommendation was rolled with, kept as it was when the recommendation was made.
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_type text CHECK (roll_type IS NULL OR roll_type = 'ADJUST_SWAP');
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_adjustment text CHECK (roll_adjustment IS NULL OR roll_adjustment IN ('SEPARATE', 'COMBINED'));
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_near_date date;
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_far_date date;
ALTER TABLE hedge_recommendation.recommendations ADD COLUMN roll_offset_days integer;

-- A part is a close-out (the maturing hedges of one value date, closed the other way), the roll (the far trade that replaces them), an adjustment, or the roll and
-- the adjustment booked as one trade. Close-outs and the roll carry their own direction, value date and fixing date; the others take the recommendation's.
ALTER TABLE hedge_recommendation.recommendation_parts ADD COLUMN role text NOT NULL DEFAULT 'ADJUSTMENT' CHECK (role IN ('ADJUSTMENT', 'CLOSE_OUT', 'ROLL', 'COMBINED'));
ALTER TABLE hedge_recommendation.recommendation_parts ADD COLUMN direction text CHECK (direction IS NULL OR direction IN ('BUY', 'SELL'));
ALTER TABLE hedge_recommendation.recommendation_parts ADD COLUMN value_date date;
ALTER TABLE hedge_recommendation.recommendation_parts ADD COLUMN fixing_date date;
