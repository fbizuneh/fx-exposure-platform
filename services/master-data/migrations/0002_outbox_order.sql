-- Events written in one transaction share a timestamp, so created_at cannot order them.
-- seq gives every event a place in the order it was written.
ALTER TABLE master_data.outbox ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX outbox_seq ON master_data.outbox (seq);
