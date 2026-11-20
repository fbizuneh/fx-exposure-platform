-- Approve Cycle attempts made while segregation of duties is on (decision 0013). An attempt is IN_FLIGHT from before it reserves itself in Hedge
-- Recommendation until it commits (COMMITTED, in the same transaction as the approval), ends without committing (FAILED, once its reservation is
-- released), or is stopped by a recovery (ABANDONED). Only an IN_FLIGHT attempt can commit, so marking it ABANDONED is what makes it unable to.
CREATE TABLE exposure_management.approval_attempts (
  tenant_id   uuid NOT NULL,
  attempt_id  uuid NOT NULL,
  cycle_id    uuid NOT NULL,
  approver    text NOT NULL,
  state       text NOT NULL CHECK (state IN ('IN_FLIGHT', 'COMMITTED', 'FAILED', 'ABANDONED')),
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  ended_by    text,
  PRIMARY KEY (tenant_id, attempt_id)
);
CREATE INDEX approval_attempts_by_cycle ON exposure_management.approval_attempts (tenant_id, cycle_id, state);
