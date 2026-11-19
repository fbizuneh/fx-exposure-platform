// What a sync, upload or manual edit sends in. Rows refer to each other by code, never by id.
import type { EntityType, HierarchyClassification, NormalBalance, StatementType } from "../contract/index.ts";

export interface EntityRow {
  readonly code: string;
  readonly name: string;
  readonly type: EntityType;
  readonly parentCode: string | null;
  readonly countryCode: string | null;
  readonly functionalCurrency: string | null;
  readonly isLegalEntity: boolean;
  readonly isTreasuryEntity: boolean;
  readonly isHedgeExecutionEntity: boolean;
}

export interface HierarchyNodeRow {
  readonly chartCode: string;
  readonly code: string;
  readonly name: string;
  readonly classification: HierarchyClassification;
  readonly parentCode: string | null;
}

export interface AccountRow {
  readonly chartCode: string;
  readonly accountNumber: string;
  readonly name: string;
  readonly statementType: StatementType;
  readonly normalBalance: NormalBalance;
  readonly monetaryFlag: boolean;
  readonly fxRelevantFlag: boolean;
  readonly hierarchyNodeCode: string | null;
}

/** A currency and whether it trades as an NDF (non-deliverable forward). */
export interface CurrencyRow {
  readonly code: string;
  readonly isNdf: boolean;
}

export type Mode = "SNAPSHOT" | "PARTIAL";
export type Kind = "ENTITY" | "HIERARCHY" | "ACCOUNT" | "CURRENCY";

/** Natural key of a hierarchy node or account within its chart. */
export const chartKey = (chartCode: string, code: string): string => JSON.stringify([chartCode, code]);
