-- Composite keys that carry the program (decision 0018): an executed trade matched to a pre-trade has the pre-trade's program. A trade with none can be stored
-- (it is unmatched), but is never matched.
--
-- Before this, an amended trade kept its pre-trade even when the amendment named another program or none. So an existing database can hold such a trade:
-- a current one is unlinked here and left unmatched, with a note, and its pre-trade's status and its recommendation's follow-up are brought up to date; a
-- superseded one is history and is left exactly as it was received. The new rules are added NOT VALID so history is not rewritten; every new or changed row
-- is held to them.
ALTER TABLE fx_trade.pre_trades ADD CONSTRAINT pre_trades_pre_trade_program_key UNIQUE (tenant_id, pre_trade_id, program_id);

CREATE TEMP TABLE affected_pre_trades AS
  SELECT DISTINCT e.tenant_id, e.pre_trade_id, p.program_id
  FROM fx_trade.executed_trades e
  JOIN fx_trade.pre_trades p ON p.tenant_id = e.tenant_id AND p.pre_trade_id = e.pre_trade_id
  WHERE e.is_current AND e.program_id IS DISTINCT FROM p.program_id;

UPDATE fx_trade.executed_trades e
SET pre_trade_id = NULL, match_status = 'UNMATCHED',
    match_note = 'The trade left its pre-trade when the program rule was added: it has no program, or not the pre-trade''s, so it is unmatched.'
FROM affected_pre_trades a
WHERE e.tenant_id = a.tenant_id AND e.pre_trade_id = a.pre_trade_id AND e.is_current AND e.program_id IS DISTINCT FROM a.program_id;

UPDATE fx_trade.pre_trades p
SET status = CASE WHEN COALESCE(f.filled, 0) >= t.deal_amount THEN 'EXECUTED' WHEN COALESCE(f.filled, 0) > 0 THEN 'PARTLY_EXECUTED' WHEN p.sent_at IS NOT NULL THEN 'SENT' ELSE 'READY' END
FROM affected_pre_trades a
JOIN fx_trade.pre_trade_legs t ON t.tenant_id = a.tenant_id AND t.pre_trade_id = a.pre_trade_id AND t.leg_no = 1
LEFT JOIN LATERAL (
  SELECT SUM(l.deal_amount) AS filled
  FROM fx_trade.executed_trades e
  JOIN fx_trade.executed_trade_legs l ON l.tenant_id = e.tenant_id AND l.executed_trade_id = e.executed_trade_id AND l.leg_no = 1
  WHERE e.tenant_id = a.tenant_id AND e.pre_trade_id = a.pre_trade_id AND e.is_current AND NOT e.cancelled
) f ON true
WHERE p.tenant_id = a.tenant_id AND p.pre_trade_id = a.pre_trade_id AND p.status NOT IN ('DRAFT', 'CANCELLED');

INSERT INTO fx_trade.outbox (event_id, tenant_id, type, payload)
SELECT x.id, x.tenant_id, 'fx-trade.pre-trade-fill-changed',
       jsonb_build_object('type', 'fx-trade.pre-trade-fill-changed', 'eventId', x.id, 'occurredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                          'tenantId', x.tenant_id, 'preTradeId', x.pre_trade_id, 'programId', x.program_id)
FROM (SELECT gen_random_uuid() AS id, a.* FROM affected_pre_trades a) x;

DROP TABLE affected_pre_trades;

ALTER TABLE fx_trade.executed_trades DROP CONSTRAINT executed_trades_tenant_id_pre_trade_id_fkey;
ALTER TABLE fx_trade.executed_trades ADD FOREIGN KEY (tenant_id, pre_trade_id, program_id) REFERENCES fx_trade.pre_trades (tenant_id, pre_trade_id, program_id) NOT VALID;
ALTER TABLE fx_trade.executed_trades ADD CONSTRAINT executed_trades_matched_has_program CHECK (pre_trade_id IS NULL OR program_id IS NOT NULL) NOT VALID;
