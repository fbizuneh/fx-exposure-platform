// Table types for the data_source schema. Keep in step with migrations/. Dates are plain YYYY-MM-DD strings.
import type { ColumnType, Generated } from "kysely";

type Json = ColumnType<unknown, string, string>;
type JsonOrNull = ColumnType<unknown, string | null, string | null>;

export interface DataSourceDatabase {
  programs: { tenant_id: string; program_id: string; program_type: string; enabled: boolean; updated_at: Generated<Date> };
  mapping_rules: {
    tenant_id: string;
    rule_id: string;
    program_id: string;
    kind: "INCLUDE" | "EXCLUDE";
    target_type: "ACCOUNT" | "NODE";
    chart_code: string;
    target_code: string;
    valid_from: string;
    valid_to: string | null;
    source_system: string | null;
    entity_code: string | null;
    dimensions: JsonOrNull;
    created_by: string;
    created_at: Generated<Date>;
  };
  batches: {
    tenant_id: string;
    batch_id: string;
    source_system: string;
    data_type: Generated<string>;
    as_of: string;
    chart_code: string;
    content_hash: string;
    status: "COMPLETED" | "COMPLETED_WITH_ISSUES" | "FAILED";
    failure_reason: string | null;
    received_count: number;
    included_count: Generated<number>;
    excluded_count: Generated<number>;
    blocked_count: Generated<number>;
    superseded_by: string | null;
    received_by: string;
    received_at: Generated<Date>;
  };
  balances: {
    tenant_id: string;
    balance_id: string;
    batch_id: string;
    source_system: string;
    as_of: string;
    row_number: number;
    record_key: string;
    entity_code: string | null;
    entity_id: string | null;
    chart_code: string;
    account_number: string | null;
    account_id: string | null;
    currency: string | null;
    amount: ColumnType<string | null, string | null, string | null>;
    dimensions: Json;
    outcome: "INCLUDED" | "EXCLUDED" | "BLOCKED";
    program_id: string | null;
    matched_rule_ids: Json;
    raw: JsonOrNull;
  };
  data_quality_issues: {
    tenant_id: string;
    issue_id: string;
    batch_id: string;
    balance_id: string | null;
    rule_code: string;
    severity: "ERROR" | "WARNING";
    description: string;
    status: "OPEN" | "RESOLVED";
    raised_at: Generated<Date>;
    resolved_at: Date | null;
  };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
