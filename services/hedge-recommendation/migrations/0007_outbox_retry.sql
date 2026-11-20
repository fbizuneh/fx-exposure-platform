-- Delivery retry (decision 0019): a failed delivery is tried again later, a few times, then marked stuck; nothing behind it for the same tenant is delivered meanwhile.
ALTER TABLE hedge_recommendation.outbox
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN stuck_at timestamptz;
CREATE INDEX outbox_tenant_order ON hedge_recommendation.outbox (tenant_id, seq) WHERE published_at IS NULL;
