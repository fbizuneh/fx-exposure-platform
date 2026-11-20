import type { ColumnType, Generated } from "kysely";
// Row types for this service's tables. Numerics and dates come back as strings (see db.ts).
export interface HedgeRecommendationDatabase {
  policies: {
    tenant_id: string; program_id: string; default_ratio: string; min_hedge_display: string; rounding_default: string; tenor: string;
    trading_entity_code: string | null; updated_by: string; updated_at: Date; max_hedge_display: string | null; split_method: string;
  };
  max_hedge_overrides: { tenant_id: string; program_id: string; netting_level: string; max_hedge_display: string };
  recommendation_parts: { tenant_id: string; recommendation_id: string; program_id: string; part_no: number; amount: string; pre_trade_id: string | null; follow_up: Generated<string> };
  ratio_overrides: { tenant_id: string; program_id: string; currency_pair: string; ratio: string };
  rounding_overrides: { tenant_id: string; program_id: string; currency: string; rounding: string };
  recommendations: {
    tenant_id: string; recommendation_id: string; program_id: string; cycle_id: string; run_id: string; strategy: string; group_no: number; netting_level: string;
    region: string | null; entity_code: string | null; currency_pair: string; exposure_currency: string; other_currency: string; trading_entity_code: string | null; decision_kind: string | null;
    gross_exposure: string; hedged_amount: string; ratio: string; target_hedge: string; needed_amount: string; rounding: string; min_exposure_amount: string | null;
    action: string; reason: string | null; direction: string | null; amount: string | null; instrument: string | null; value_date: string | null; fixing_date: string | null;
    status: string; decided_amount: string | null; decided_by: string | null; decided_at: Date | null; decision_note: string | null;
    max_exposure_amount: string | null; split_method: string | null; split_note: string | null;
    follow_up: Generated<string>; created_at: Date; calendar_gaps: ColumnType<unknown, string, string>;
  };
  approval_holds: { tenant_id: string; hold_id: string; cycle_id: string; approver: string; held_at: Date };
  processed_events: { tenant_id: string; event_id: string };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
