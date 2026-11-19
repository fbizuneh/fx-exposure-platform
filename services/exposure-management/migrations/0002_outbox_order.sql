-- Events written in one transaction share a timestamp, so created_at cannot order them.
-- seq gives every event a place in the order it was written.
ALTER TABLE exposure_management.outbox ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX outbox_seq ON exposure_management.outbox (seq);
