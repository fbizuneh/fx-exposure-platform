// Table types for the fx_trade schema. Keep in step with migrations/. Dates are plain YYYY-MM-DD strings, numerics are strings.
import type { Generated } from "kysely";

type Instrument = "SPOT" | "FORWARD" | "NDF" | "SWAP";
type Role = "SINGLE" | "NEAR" | "FAR";
interface LegColumns {
  tenant_id: string;
  leg_no: number;
  leg_role: Role;
  direction: "BUY" | "SELL";
  deal_currency: string;
  deal_amount: string;
  settlement_currency: string;
  value_date: string;
  fixing_date: string | null;
}

export interface FxTradeDatabase {
  pre_trades: {
    tenant_id: string;
    pre_trade_id: string;
    reference: string;
    program_id: string;
    cycle_id: string | null;
    recommendation_id: string | null;
    part_no: number | null;
    origin: "RECOMMENDATION" | "MANUAL";
    status: "DRAFT" | "READY" | "SENT" | "PARTLY_EXECUTED" | "EXECUTED" | "CANCELLED";
    trading_entity_code: string;
    instrument: Instrument;
    released_at: Date | null;
    sent_at: Date | null;
    created_by: string;
    created_at: Generated<Date>;
  };
  pre_trade_legs: LegColumns & { pre_trade_id: string; settlement_amount: string | null };
  trade_batches: { tenant_id: string; batch_id: string; content_hash: string; received: number; stored: number; unchanged: number; blocked: number; created_by: string; created_at: Generated<Date> };
  executed_trades: {
    tenant_id: string;
    executed_trade_id: string;
    platform: string;
    trade_id: string;
    version: number;
    is_current: boolean;
    cancelled: boolean;
    content_hash: string;
    batch_id: string | null;
    program_id: string | null;
    trading_entity_code: string;
    counterparty: string | null;
    trade_date: string;
    instrument: Instrument;
    portfolio: string | null;
    custom_fields: Record<string, string> | string;
    pre_trade_reference: string | null;
    pre_trade_id: string | null;
    match_status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
    match_note: string | null;
    candidates: string[] | string;
    received_at: Generated<Date>;
  };
  executed_trade_legs: LegColumns & { executed_trade_id: string; settlement_amount: string };
  trade_issues: { tenant_id: string; issue_id: string; batch_id: string; row_no: number; code: string; message: string; raw: Record<string, unknown> | string; created_at: Generated<Date> };
  handled_events: { tenant_id: string; event_id: string };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
