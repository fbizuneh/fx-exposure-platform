// Published questions and events of Data Source. Other services import this file, never src/.
import type { AccountId, AsOfDate, EntityId, LineageRef, ProgramId, TenantId } from "@shared/kernel";

/** One included balance, stamped with its program. Amounts are debit-positive decimal strings. */
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

export interface DataSourceQuestions {
  /** The balances stamped with a program that are in scope, from the current batches. */
  includedBalances(query: IncludedBalancesQuery): Promise<readonly IncludedBalance[]>;
  ingestionStatus(tenantId: TenantId, filter?: { readonly sourceSystem?: string; readonly asOf?: AsOfDate }): Promise<readonly IngestionStatus[]>;
  dataQualityIssues(
    tenantId: TenantId,
    filter?: { readonly batchId?: string; readonly asOf?: AsOfDate; readonly status?: "OPEN" | "RESOLVED"; readonly limit?: number },
  ): Promise<readonly DataQualityIssue[]>;
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
export type DataSourceEvents = DataStamped | IssuesRaised;
