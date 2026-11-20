// Published questions and events of Hedge Recommendation. Other services import this file, never src/.
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";

export const STRATEGIES = ["hedge-ratio-adjustment"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** A policy with its defaults filled in. Amounts and ratios are decimal strings (ratio 1 is 100%). */
export interface HedgePolicy {
  readonly programId: ProgramId;
  readonly defaultRatio: string;
  readonly ratioOverrides: readonly { readonly pair: string; readonly ratio: string }[];
  /** In the program's display currency. */
  readonly minHedgeDisplay: string;
  readonly roundingDefault: string;
  readonly roundingOverrides: readonly { readonly currency: string; readonly rounding: string }[];
  /** "1M", "2W" and so on. */
  readonly tenor: string;
  readonly tradingEntityCode: string | null;
  /** False when nothing has been saved and the defaults apply. */
  readonly saved: boolean;
}

export type RecommendationStatus = "OPEN" | "ACCEPTED" | "OVERRIDDEN" | "DISMISSED" | "LAPSED" | "SUPERSEDED" | "NONE";
export type FollowUp = "NOT_STARTED" | "OPEN" | "PARTLY_EXECUTED" | "EXECUTED" | "CANCELLED";
export type NoActionReason = "WITHIN_TARGET" | "ROUNDS_TO_ZERO" | "BELOW_MINIMUM" | "NO_RATE";

export interface Recommendation {
  readonly recommendationId: string;
  readonly programId: ProgramId;
  readonly cycleId: CycleId;
  readonly runId: string;
  readonly strategy: Strategy;
  readonly groupNo: number;
  readonly nettingLevel: string;
  readonly region: string | null;
  readonly entityCode: string | null;
  readonly currencyPair: string;
  readonly exposureCurrency: string;
  readonly otherCurrency: string;
  /** In the exposure currency, signed: positive is long. */
  readonly grossExposure: string;
  readonly hedgedAmount: string;
  readonly ratio: string;
  readonly targetHedge: string;
  readonly neededAmount: string;
  readonly rounding: string;
  readonly minExposureAmount: string | null;
  readonly action: "HEDGE" | "NONE";
  readonly reason: NoActionReason | null;
  readonly direction: "BUY" | "SELL" | null;
  /** Positive, in the exposure currency. */
  readonly amount: string | null;
  readonly instrument: "FORWARD" | "NDF" | null;
  readonly valueDate: string | null;
  readonly fixingDate: string | null;
  readonly status: RecommendationStatus;
  readonly decidedAmount: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly preTradeId: string | null;
  readonly followUp: FollowUp;
}

export interface HedgeRecommendationQuestions {
  /** The saved policy, or the defaults when none is saved. */
  policy(tenantId: TenantId, programId: ProgramId): Promise<HedgePolicy>;
  /** The cycle's current recommendations (not superseded ones), actions first. */
  recommendations(tenantId: TenantId, cycleId: CycleId): Promise<readonly Recommendation[]>;
  getRecommendation(tenantId: TenantId, recommendationId: string): Promise<Recommendation | null>;
}

interface Announcement {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}
/** A finished run produced recommendations for the cycle. */
export interface RecommendationsIssued extends Announcement {
  readonly type: "hedge-recommendation.recommendations-issued";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly runId: string;
}
/** A decision made a pre-trade in FX Trade. */
export interface PreTradeCreated extends Announcement {
  readonly type: "hedge-recommendation.pre-trade-created";
  readonly recommendationId: string;
  readonly preTradeId: string;
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
}
export type HedgeRecommendationEvents = RecommendationsIssued | PreTradeCreated;
