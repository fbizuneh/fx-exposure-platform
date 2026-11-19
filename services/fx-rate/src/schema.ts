// Table types for the fx_rate schema. Keep in step with migrations/. Dates are plain YYYY-MM-DD strings.
import type { ColumnType, Generated } from "kysely";

type Num = ColumnType<string, string, string>;
type NumOrNull = ColumnType<string | null, string | null, string | null>;

export interface FxRateDatabase {
  tenant_settings: { tenant_id: string; preferred_source: string | null; pivot_currency: Generated<string>; outlier_share: Generated<string>; updated_at: Generated<Date> };
  rate_sources: { tenant_id: string; source_code: string; stale_after_minutes: number | null; created_at: Generated<Date> };
  rate_loads: {
    tenant_id: string;
    load_id: string;
    source_code: string;
    business_date: string;
    content_hash: string;
    row_count: number;
    warning_count: number;
    created_by: string;
    created_at: Generated<Date>;
  };
  rates: {
    tenant_id: string;
    rate_id: string;
    load_id: string;
    source_code: string;
    business_date: string;
    base_currency: string;
    quote_currency: string;
    rate_type: "SPOT" | "FORWARD";
    tenor: string;
    value_date: string | null;
    all_in_rate: Num;
    spot_rate: NumOrNull;
    forward_points: NumOrNull;
    bid: NumOrNull;
    mid: NumOrNull;
    ask: NumOrNull;
    observed_at: Date;
    quality: "VALID" | "STALE" | "OUTLIER";
    loaded_at: Generated<Date>;
  };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
