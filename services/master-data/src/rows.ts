// What a sync, upload or manual edit sends in. Rows refer to each other by code, never by id.
import type { EntityType, Weekday, HierarchyClassification, NormalBalance, StatementType } from "../contract/index.ts";

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

/** One currency's business-day calendar (decision 0014). */
export interface CalendarRow {
  readonly currencyCode: string;
  readonly weekendDays: readonly Weekday[];
  readonly coveredThrough: string;
  readonly holidays: readonly { readonly date: string; readonly name: string | null }[];
}

/** Which currency of a pair is the exposure currency for one hedging program (decision 0015). The pair may be written in either order. */
export interface PairExposureCurrencyRow {
  readonly programCode: string;
  readonly pair: string;
  readonly exposureCurrency: string;
}

/** A pair in alphabetical order, "EUR-GBP" for "GBP-EUR": the same pair written either way is the same row. */
export const normalPair = (pair: string): string => (typeof pair === "string" ? pair.split("-").sort().join("-") : pair);

export type Mode = "SNAPSHOT" | "PARTIAL";
export type Kind = "ENTITY" | "HIERARCHY" | "ACCOUNT" | "CURRENCY" | "CALENDAR" | "EXPOSURE_CURRENCY";

/** Natural key of a hierarchy node or account within its chart. */
export const chartKey = (chartCode: string, code: string): string => JSON.stringify([chartCode, code]);
