-- Audit: an append-only, tamper-evident trail of change records. Every table carries tenant_id.
CREATE TABLE audit.records (
  tenant_id    uuid NOT NULL,
  seq          bigint NOT NULL,
  record_id    uuid NOT NULL,
  source       text NOT NULL,
  program_id   text,
  actor        text NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  fields       jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL,
  prev_hash    text NOT NULL,
  hash         text NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, record_id)
);
CREATE INDEX records_program ON audit.records (tenant_id, program_id, seq);
CREATE INDEX records_target ON audit.records (tenant_id, target_type, target_id);
CREATE INDEX records_actor ON audit.records (tenant_id, actor);

-- The end of each tenant's chain. Appending takes its lock, so records join the chain one at a time.
CREATE TABLE audit.chain_heads (
  tenant_id  uuid PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL
);

-- A record is never changed or removed by this service or anyone using its connection.
CREATE FUNCTION audit.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only (% on audit.records refused)', TG_OP;
END;
$$;
CREATE TRIGGER records_no_update_delete BEFORE UPDATE OR DELETE ON audit.records FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER records_no_truncate BEFORE TRUNCATE ON audit.records FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
