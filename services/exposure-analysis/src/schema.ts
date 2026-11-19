// Table types for the exposure_analysis schema. Keep in step with migrations/. Dates are YYYY-MM-DD strings, numerics exact strings.
import type { ColumnType, Generated } from "kysely";

type JsonIn = ColumnType<unknown, string, string>;
type JsonOrNull = ColumnType<unknown, string | null, string | null>;

export interface ExposureAnalysisDatabase {
  runs: {
    tenant_id: string;
    run_id: string;
    program_id: string;
    cycle_id: string;
    as_of: string;
    trigger_event_id: string;
    status: "WAITING" | "FINISHED" | "SUPERSEDED";
    wait_reason: string | null;
    netting_level: string;
    display_currency: string;
    counts: JsonOrNull;
    blocked_count: number | null;
    warnings: JsonOrNull;
    created_at: Generated<Date>;
    attempted_at: Generated<Date>;
    finished_at: Date | null;
    frozen_at: Date | null;
  };
  baseline_rows: {
    tenant_id: string;
    program_id: string;
    run_id: string;
    row_no: number;
    source_system: string;
    batch_id: string;
    record_id: string;
    entity_code: string;
    region: string;
    chart_code: string;
    account_number: string;
    period: string;
    transaction_currency: string;
    functional_currency: string;
    currency_pair: string;
    currency1: string;
    currency2: string;
    pair_rate: string;
    amount: string;
    amount1: string;
    amount2: string;
    dimensions: JsonIn;
  };
  exposure_groups: {
    tenant_id: string;
    program_id: string;
    run_id: string;
    group_no: number;
    netting_level: string;
    region: string | null;
    entity_code: string | null;
    currency_pair: string;
    currency1: string;
    currency2: string;
    exposure_currency: string;
    period: string;
    row_count: number;
    long1: string;
    short1: string;
    net1: string;
    net2: string;
    exposure_amount: string;
    display_currency: string;
    display_rate: string;
    display_amount: string;
  };
  group_members: { tenant_id: string; program_id: string; run_id: string; group_no: number; row_no: number; amount1: string; amount2: string };
  rates_used: {
    tenant_id: string;
    program_id: string;
    run_id: string;
    base: string;
    quote: string;
    purpose: "PAIR" | "DISPLAY" | "PORTFOLIO";
    rate: string;
    quality: string;
    derivation: string;
    source: string | null;
    load_ids: JsonIn;
  };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
