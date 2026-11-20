// Published questions and events of Hedge Recommendation. Other services import this file, never src/.
import type { ChangeRecordFields } from "@services/audit/contract";
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

/** DECIDING: an accept or override has won and its pre-trade is being made; it ends as accepted, overridden, or back to open if FX Trade refuses. */
export type RecommendationStatus = "OPEN" | "DECIDING" | "ACCEPTED" | "OVERRIDDEN" | "DISMISSED" | "LAPSED" | "SUPERSEDED" | "NONE";
export type FollowUp = "NOT_STARTED" | "OPEN" | "PARTLY_EXECUTED" | "EXECUTED" | "CANCELLED";
export type NoActionReason = "WITHIN_TARGET" | "ROUNDS_TO_ZERO" | "BELOW_MINIMUM" | "NO_RATE" | "NO_TRADING_ENTITY";
/** What to tell the user for each reason a group has no actionable recommendation. */
export const NO_ACTION_MESSAGES: Readonly<Record<NoActionReason, string>> = {
  WITHIN_TARGET: "Already hedged to the target ratio.",
  ROUNDS_TO_ZERO: "The amount needed is smaller than the rounding step.",
  BELOW_MINIMUM: "The rounded amount is below the minimum hedge amount.",
  NO_RATE: "The spot rate needed to convert the minimum hedge amount is missing.",
  NO_TRADING_ENTITY: "This netting group has no entity. Configure a default trading entity in the hedge policy to get a recommendation for it.",
};

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
  /** The group's entity when the netting level has one, otherwise the policy's default trading entity; null when neither exists. */
  readonly tradingEntityCode: string | null;
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
  /** Who accepted or overrode a recommendation of the cycle, as actor labels ("user:<id>"), each once. A decision still waiting on its pre-trade counts. Dismissals do not. */
  deciders(tenantId: TenantId, cycleId: CycleId): Promise<readonly string[]>;
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

/** A change record for Audit (decision 0012): who did what to which record. Identifiers and field names only. */
export interface HedgeRecommendationChangeRecorded extends ChangeRecordFields {
  readonly type: "hedge-recommendation.change-recorded";
  readonly eventId: string;
  readonly occurredAt: string;
}
export type HedgeRecommendationEvents = RecommendationsIssued | PreTradeCreated | HedgeRecommendationChangeRecorded;
