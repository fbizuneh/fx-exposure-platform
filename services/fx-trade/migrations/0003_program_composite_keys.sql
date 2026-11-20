-- Composite keys that carry the program (decision 0018): an executed trade matched to a pre-trade has the pre-trade's program. A trade with no program can
-- be stored (it is unmatched), but it can never be matched.
ALTER TABLE fx_trade.pre_trades ADD CONSTRAINT pre_trades_pre_trade_program_key UNIQUE (tenant_id, pre_trade_id, program_id);
ALTER TABLE fx_trade.executed_trades DROP CONSTRAINT executed_trades_tenant_id_pre_trade_id_fkey;
ALTER TABLE fx_trade.executed_trades ADD FOREIGN KEY (tenant_id, pre_trade_id, program_id) REFERENCES fx_trade.pre_trades (tenant_id, pre_trade_id, program_id);
ALTER TABLE fx_trade.executed_trades ADD CONSTRAINT executed_trades_matched_has_program CHECK (pre_trade_id IS NULL OR program_id IS NOT NULL);
