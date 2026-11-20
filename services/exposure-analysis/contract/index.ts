// Published questions and events of Exposure Analysis. Other services import this file, never src/.
import type { AsOfDate, CycleId, LineageRef, ProgramId, TenantId } from "@shared/kernel";
import type { NettingLevel } from "@services/exposure-management/contract";

export const RUN_STATUSES = ["WAITING", "FINISHED", "SUPERSEDED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What the filter set aside, and why. Every received balance is in exactly one of these. */
export interface FilterCounts {
  readonly received: number;
  readonly kept: number;
  /** The entity is not a legal entity on the as-of date, or Master Data does not know it. */
  readonly notLegalEntity: number;
  /** The account is not flagged both FX-relevant and monetary, or Master Data does not know it. */
  readonly accountNotInScope: number;
  /** The balance is in the entity's functional currency, so carries no exposure. */
  readonly functionalCurrency: number;
  /** The legal entity has no functional currency. */
  readonly noFunctionalCurrency: number;
}

/** What the run did with FX Trade's outstanding hedges (decision 0010). */
export interface HedgeCounts {
  /** Executed trades open on the as-of date, as FX Trade returned them. */
  readonly trades: number;
  /** Their legs with a value date after the as-of date, which are the ones that count. */
  readonly openLegs: number;
  /** Open legs used as hedge rows. */
  readonly used: number;
  /** Open legs left out because the trading entity is not on record in Master Data on the as-of date. */
  readonly noEntity: number;
  /** Every leg left out, so a user can fix the setup and recalculate. The run finishes without them; it does not wait. */
  readonly excluded: readonly HedgeExclusion[];
}

export interface HedgeExclusion {
  readonly executedTradeId: string;
  readonly platform: string;
  readonly tradeId: string;
  readonly legNo: number;
  readonly entityCode: string;
  readonly reason: "TRADING_ENTITY_NOT_ON_RECORD";
}

export interface RateWarning {
  readonly base: string;
  readonly quote: string;
  readonly quality: "STALE" | "OUTLIER";
}

export interface RunSummary {
  readonly runId: string;
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
  readonly status: RunStatus;
  /** Why a waiting run has not run yet. */
  readonly waitReason: string | null;
  readonly nettingLevel: NettingLevel;
  readonly displayCurrency: string;
  readonly counts: FilterCounts | null;
  readonly hedgeCounts: HedgeCounts | null;
  /** Blocked balances across the tenant's current batches for the as-of date. */
  readonly blockedBalances: number | null;
  readonly warnings: readonly RateWarning[];
  readonly attemptedAt: string;
  readonly finishedAt: string | null;
  readonly frozenAt: string | null;
}

/** Amounts are exact decimal strings rounded to 2 places; clients show them with 0 decimal places.
 *  Gross exposure of one netting group: a currency pair in a period, within the netting level's partition. */
export interface ExposureGroup {
  readonly groupNo: number;
  readonly nettingLevel: NettingLevel;
  /** Set for the region levels; "UNASSIGNED" for an entity with no region. Null otherwise. */
  readonly region: string | null;
  /** Set for the entity levels. Null otherwise. */
  readonly entityCode: string | null;
  readonly currencyPair: string;
  readonly currency1: string;
  readonly currency2: string;
  /** The currency the exposure is in (decision 0008): fixed at portfolio and entity levels, otherwise the program's override or the default logic. */
  readonly exposureCurrency: string;
  readonly period: AsOfDate;
  readonly rowCount: number;
  /** On currency 1: the sum of the positive amounts, of the negative amounts, and their total. */
  readonly long1: string;
  readonly short1: string;
  readonly net1: string;
  readonly net2: string;
  readonly exposureAmount: string;
  readonly displayCurrency: string;
  readonly displayRate: string;
  readonly displayAmount: string;
}

/** One baseline row behind a group, with its lineage back to the balance in Data Source. */
export interface BaselineRow {
  readonly rowNo: number;
  readonly lineage: LineageRef;
  readonly entityCode: string;
  readonly region: string;
  readonly chartCode: string;
  readonly accountNumber: string;
  readonly period: AsOfDate;
  readonly transactionCurrency: string;
  readonly functionalCurrency: string;
  readonly currencyPair: string;
  readonly pairRate: string;
  /** The balance, signed as the source sent it. */
  readonly amount: string;
  readonly amount1: string;
  readonly amount2: string;
  readonly dimensions: Readonly<Record<string, string>>;
  /** What this row contributes to the group asked about. Differs from amount1 and amount2 at the portfolio level. */
  readonly contribution: { readonly amount1: string; readonly amount2: string };
}

/** The three amounts of a net exposure group. Positive is long; a hedge against a long exposure is negative. */
export interface ExposureAmounts {
  readonly net1: string;
  readonly net2: string;
  /** In the group's exposure currency. */
  readonly exposureAmount: string;
  readonly displayAmount: string;
}

/** Net exposure of one netting group: gross exposure plus outstanding hedges (decision 0010). Same keys as `ExposureGroup`. */
export interface NetExposureGroup {
  readonly groupNo: number;
  readonly nettingLevel: NettingLevel;
  readonly region: string | null;
  readonly entityCode: string | null;
  readonly currencyPair: string;
  readonly currency1: string;
  readonly currency2: string;
  readonly exposureCurrency: string;
  readonly period: AsOfDate;
  readonly displayCurrency: string;
  readonly displayRate: string;
  readonly gross: ExposureAmounts;
  readonly hedges: ExposureAmounts;
  readonly net: ExposureAmounts;
}

/** One open hedge leg behind the net figures, traceable to the executed trade version used. */
export interface HedgeRow {
  readonly rowNo: number;
  readonly executedTradeId: string;
  readonly platform: string;
  readonly tradeId: string;
  readonly legNo: number;
  readonly entityCode: string;
  readonly region: string;
  readonly period: AsOfDate;
  readonly dealCurrency: string;
  readonly settlementCurrency: string;
  readonly currencyPair: string;
  readonly amount1: string;
  readonly amount2: string;
  /** When the leg matures (decision 0021). Null for a run made before it was kept. */
  readonly valueDate: AsOfDate | null;
  /** The net group (its `groupNo`) the leg fell in, and its amount in that group's exposure currency. Null for a run made before they were kept. */
  readonly groupNo: number | null;
  readonly exposureAmount: string | null;
}

export interface RateUsed {
  readonly base: string;
  readonly quote: string;
  readonly purpose: "PAIR" | "DISPLAY" | "PORTFOLIO";
  readonly rate: string;
  readonly quality: "VALID" | "STALE" | "OUTLIER";
  readonly derivation: string;
  readonly source: string | null;
  readonly loadIds: readonly string[];
}

export interface ExposureAnalysisQuestions {
  /** The cycle's current run (waiting or finished), or null when none has been saved. */
  currentRun(tenantId: TenantId, cycleId: CycleId): Promise<RunSummary | null>;
  /** Gross exposure of a finished run, ordered by pair, period, then partition. */
  exposures(tenantId: TenantId, runId: string): Promise<readonly ExposureGroup[]>;
  /** The baseline rows behind one group. */
  drilldown(tenantId: TenantId, runId: string, groupNo: number): Promise<readonly BaselineRow[]>;
  ratesUsed(tenantId: TenantId, runId: string): Promise<readonly RateUsed[]>;
  /** Gross, hedges and net per netting group of a finished run, ordered like `exposures`. */
  netExposures(tenantId: TenantId, runId: string): Promise<readonly NetExposureGroup[]>;
  /** The open hedge legs a finished run used. */
  hedgeRows(tenantId: TenantId, runId: string): Promise<readonly HedgeRow[]>;
}

interface Announcement {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}
/** A run is complete and is about to be announced as finished. Exposure Management moves the cycle to in progress. */
export interface RunStarted extends Announcement {
  readonly type: "exposure-analysis.run-started";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly runId: string;
}
/** Exposure Management moves the cycle to completed, provided the run ID is the one that started. */
export interface RunFinished extends Announcement {
  readonly type: "exposure-analysis.run-finished";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly runId: string;
}
export type ExposureAnalysisEvents = RunStarted | RunFinished;
