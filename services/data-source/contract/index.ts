// Published questions and events of Data Source. Other services import this file, never src/.
import type { AccountId, AsOfDate, EntityId, LineageRef, ProgramId, TenantId } from "@shared/kernel";
import type { ChangeRecordFields } from "@services/audit/contract";

/** One included balance, stamped with its program. Amounts are signed decimal strings, kept as the source sent them; the sign says nothing about asset or liability. */
export interface IncludedBalance {
  readonly lineage: LineageRef;
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
  readonly entityId: EntityId;
  readonly entityCode: string;
  readonly accountId: AccountId;
  readonly chartCode: string;
  readonly accountNumber: string;
  readonly currency: string;
  readonly amount: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

export interface IncludedBalancesQuery {
  readonly tenantId: TenantId;
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
  /** Limits the answer to these entities. */
  readonly entityIds?: readonly EntityId[];
  readonly sourceSystem?: string;
}

export const BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ISSUES", "FAILED"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface IngestionStatus {
  readonly batchId: string;
  readonly sourceSystem: string;
  readonly asOf: AsOfDate;
  readonly status: BatchStatus;
  /** True for the latest batch of its source system and date. Failed batches are never current. */
  readonly current: boolean;
  readonly received: number;
  readonly included: number;
  readonly excluded: number;
  readonly blocked: number;
  readonly failureReason: string | null;
  readonly receivedAt: string;
}

export interface DataQualityIssue {
  readonly issueId: string;
  readonly batchId: string;
  /** Null for an issue about the batch as a whole. */
  readonly lineage: LineageRef | null;
  readonly ruleCode: string;
  readonly severity: "ERROR" | "WARNING";
  readonly description: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly raisedAt: string;
}

/**
 * How a batch's rows add up in one currency: how many rows and their signed amounts, received and then split by outcome.
 * `receivedRows`/`receivedSum` always equal the included, excluded and blocked numbers added together. A row with no
 * currency, or an amount intake could not parse, is grouped under `currency: ""` and contributes 0 to that bucket's sum.
 * Sums are `decimal.js` strings, fixed to 4 places.
 */
export interface CurrencyControlTotal {
  readonly currency: string;
  readonly receivedRows: number;
  readonly receivedSum: string;
  readonly includedRows: number;
  readonly includedSum: string;
  readonly excludedRows: number;
  readonly excludedSum: string;
  readonly blockedRows: number;
  readonly blockedSum: string;
}

export interface DataSourceQuestions {
  /** The balances stamped with a program that are in scope, from the current batches. */
  includedBalances(query: IncludedBalancesQuery): Promise<readonly IncludedBalance[]>;
  ingestionStatus(tenantId: TenantId, filter?: { readonly sourceSystem?: string; readonly asOf?: AsOfDate }): Promise<readonly IngestionStatus[]>;
  dataQualityIssues(
    tenantId: TenantId,
    filter?: { readonly batchId?: string; readonly asOf?: AsOfDate; readonly status?: "OPEN" | "RESOLVED"; readonly limit?: number },
  ): Promise<readonly DataQualityIssue[]>;
  /** How the batch's rows add up by currency (decision 0006/#J1). A batch that does not exist, or belongs to another tenant, is an error naming neither. */
  controlTotals(tenantId: TenantId, batchId: string): Promise<readonly CurrencyControlTotal[]>;
}

/** A batch was stamped. It carries identifiers only; receivers ask Data Source for detail. */
export interface DataStamped {
  readonly type: "data-source.batch-stamped";
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly batchId: string;
  readonly sourceSystem: string;
  readonly asOf: AsOfDate;
}

/** A batch raised data quality issues, which includes any blocked balance. */
export interface IssuesRaised {
  readonly type: "data-source.issues-raised";
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly batchId: string;
}

/** A change record for Audit (decision 0012): who did what to which record. Identifiers and field names only. */
export interface DataSourceChangeRecorded extends ChangeRecordFields {
  readonly type: "data-source.change-recorded";
  readonly eventId: string;
  readonly occurredAt: string;
}
export type DataSourceEvents = DataStamped | IssuesRaised | DataSourceChangeRecorded;
