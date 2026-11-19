// Table types for the exposure_management schema. Keep in step with migrations/. Dates are plain YYYY-MM-DD strings.
import type { ColumnType, Generated } from "kysely";

type JsonIn = ColumnType<unknown, string, string>;
type JsonOrNull = ColumnType<unknown, string | null, string | null>;

export interface ExposureManagementDatabase {
  programs: {
    tenant_id: string;
    program_id: string;
    name: string;
    program_type: "BALANCE_SHEET" | "CASH_FLOW" | "BUDGET_TO_CASH" | "IN_HOUSE_BANK";
    enabled: boolean;
    created_by: string;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  program_settings: {
    tenant_id: string;
    program_id: string;
    valid_from: string;
    valid_to: string | null;
    netting_level: "GROUP_NATURAL" | "GROUP_PORTFOLIO" | "REGION" | "REGION_BY_ENTITY" | "ENTITY";
    display_currency: string;
    exposure_currency_overrides: JsonIn;
    bucket_scheme: JsonIn;
    schedule: JsonOrNull;
    changed_by: string;
    changed_at: Generated<Date>;
  };
  cycles: {
    tenant_id: string;
    cycle_id: string;
    program_id: string;
    as_of: string;
    stage: "INITIATED" | "IN_PROGRESS" | "COMPLETED";
    outcome: "SKIPPED" | "DELETED" | null;
    outcome_reason: string | null;
    settings: JsonIn;
    rerun_count: Generated<number>;
    current_run_id: string | null;
    approved_at: Date | null;
    approved_by: string | null;
    initiated_by: string;
    initiated_at: Generated<Date>;
  };
  cycle_history: {
    tenant_id: string;
    cycle_id: string;
    seq: number;
    kind: "INITIATED" | "RUN_STARTED" | "RUN_FINISHED" | "RERUN" | "SKIPPED" | "DELETED" | "APPROVED";
    by_who: string | null;
    at: Generated<Date>;
    note: string | null;
  };
  outbox: { event_id: string; tenant_id: string; type: string; payload: string; created_at: Generated<Date>; seq: Generated<string>; published_at: Date | null };
}
