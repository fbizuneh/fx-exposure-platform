-- Events written in one transaction share a timestamp, so created_at cannot order them.
-- seq gives every event a place in the order it was written.
ALTER TABLE fx_rate.outbox ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX outbox_seq ON fx_rate.outbox (seq);
