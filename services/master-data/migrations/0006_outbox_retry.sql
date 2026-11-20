-- Delivery retry (decision 0019): a failed delivery is tried again later, a few times, then marked stuck (the constraint refuses a counted failure that is neither waiting nor stuck, so a half-written failure cannot persist); nothing behind it for the same tenant is delivered meanwhile.
ALTER TABLE master_data.outbox
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN stuck_at timestamptz,
  ADD CONSTRAINT outbox_failure_state CHECK (attempts = 0 OR published_at IS NOT NULL OR retry_at IS NOT NULL OR stuck_at IS NOT NULL);
CREATE INDEX outbox_tenant_order ON master_data.outbox (tenant_id, seq) WHERE published_at IS NULL;
