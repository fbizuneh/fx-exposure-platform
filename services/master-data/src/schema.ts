// Table types for the master_data schema. Keep in step with migrations/. Dates are plain YYYY-MM-DD strings.
import type { ColumnType, Generated } from "kysely";

type Json = ColumnType<unknown, string, string>;

interface Versioned {
  tenant_id: string;
  valid_from: string;
  valid_to: string | null;
  source_system: string;
  batch_id: string;
}

export interface MasterDataDatabase {
  tenant_settings: { tenant_id: string; max_end_share: Generated<string>; updated_at: Generated<Date> };
  charts_of_accounts: { tenant_id: string; chart_id: Generated<string>; code: string; name: string; created_at: Generated<Date> };
  entities: Versioned & {
    entity_id: string;
    code: string;
    name: string;
    entity_type: string;
    parent_entity_id: string | null;
    country_code: string | null;
    functional_currency: string | null;
    is_legal_entity: boolean;
    is_treasury_entity: boolean;
    is_hedge_execution_entity: boolean;
  };
  gl_hierarchy_nodes: Versioned & {
    node_id: string;
    chart_id: string;
    code: string;
    name: string;
    classification: string;
    parent_node_id: string | null;
  };
  accounts: Versioned & {
    account_id: string;
    chart_id: string;
    account_number: string;
    name: string;
    hierarchy_node_id: string | null;
    statement_type: string;
    normal_balance: string;
    monetary_flag: boolean;
    fx_relevant_flag: boolean;
  };
  pair_exposure_currencies: Versioned & { mapping_id: string; program_id: string; pair: string; exposure_currency: string };
  pair_exposure_currency_history: { tenant_id: string; program_id: string; latest_effective: string };
  calendars: Versioned & { calendar_id: string; code: string; weekend_days: string[]; covered_through: string; holidays: Json };
  currencies: Versioned & { currency_id: string; code: string; is_ndf: boolean };
  change_sets: {
    tenant_id: string;
    batch_id: Generated<string>;
    source_system: string;
    kind: string;
    mode: string;
    as_of: string;
    content_hash: string;
    status: "APPLIED" | "HELD" | "REJECTED";
    rows: Json;
    open_count: number;
    end_count: number;
    held_reason: string | null;
    scope_key: Generated<string>;
    created_by: string;
    created_at: Generated<Date>;
    decided_by: string | null;
    decided_at: Date | null;
  };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null; attempts: Generated<number>; last_error: string | null; retry_at: Date | null; stuck_at: Date | null };
}
