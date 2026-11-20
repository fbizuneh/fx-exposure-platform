-- Reservations made by an Approve Cycle in flight under segregation of duties (decision 0013): while one stands, its approver cannot win an accept or
-- override on the cycle. Cycle-level, short-lived; cleared when the cycle is approved, skipped or deleted.
CREATE TABLE hedge_recommendation.approval_holds (
  tenant_id  uuid NOT NULL,
  hold_id    uuid NOT NULL,
  cycle_id   uuid NOT NULL,
  approver   text NOT NULL,
  held_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, hold_id)
);
CREATE INDEX approval_holds_cycle ON hedge_recommendation.approval_holds (tenant_id, cycle_id);
