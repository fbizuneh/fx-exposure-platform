// Published questions and events of Hedge Recommendation. Other services import this file, never src/.
import type { ChangeRecordFields } from "@services/audit/contract";
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";

export const STRATEGIES = ["hedge-ratio-adjustment", "amount-threshold"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const SPLIT_METHODS = ["EVEN", "THRESHOLD_REMAINDER"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

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
  /** The largest amount of one hedge, in the display currency (decision 0016); null when there is no maximum. A larger recommendation is split into parts. */
  readonly maxHedgeDisplay: string | null;
  /** A different maximum for the groups of a netting level; it replaces the program's maximum for them. */
  readonly maxHedgeOverrides: readonly { readonly nettingLevel: string; readonly maxHedgeDisplay: string }[];
  /** EVEN: equal parts. THRESHOLD_REMAINDER: parts of the maximum and one part for what is left. */
  readonly splitMethod: SplitMethod;
  /** The strategy the program uses (decision 0020). The ratio settings apply to hedge-ratio-adjustment only, the threshold settings to amount-threshold only. */
  readonly strategy: Strategy;
  /** The amount threshold in the display currency: the net exposure must be larger than it for a hedge to be recommended. Required for the amount-threshold strategy. */
  readonly amountThresholdDisplay: string | null;
  /** A different threshold for the groups of a netting level; it replaces the program's threshold for them. */
  readonly amountThresholdOverrides: readonly { readonly nettingLevel: string; readonly amountThresholdDisplay: string }[];
  /** False when nothing has been saved and the defaults apply. */
  readonly saved: boolean;
}

/** DECIDING: an accept or override has won and its pre-trade is being made; it ends as accepted, overridden, or back to open if FX Trade refuses. */
export type RecommendationStatus = "OPEN" | "DECIDING" | "ACCEPTED" | "OVERRIDDEN" | "DISMISSED" | "LAPSED" | "SUPERSEDED" | "NONE";
/** EXECUTED_REST_CANCELLED: every part is finished, some executed and some cancelled (decision 0017). Only a whole recommendation has it, never a part. */
export type FollowUp = "NOT_STARTED" | "OPEN" | "PARTLY_EXECUTED" | "EXECUTED" | "EXECUTED_REST_CANCELLED" | "CANCELLED";
export type NoActionReason = "WITHIN_TARGET" | "WITHIN_THRESHOLD" | "ROUNDS_TO_ZERO" | "BELOW_MINIMUM" | "NO_RATE" | "NO_TRADING_ENTITY";
/** What to tell the user for each reason a group has no actionable recommendation. */
export const NO_ACTION_MESSAGES: Readonly<Record<NoActionReason, string>> = {
  WITHIN_TARGET: "Already hedged to the target ratio.",
  WITHIN_THRESHOLD: "The net exposure is not larger than the amount threshold.",
  ROUNDS_TO_ZERO: "The amount needed is smaller than the rounding step.",
  BELOW_MINIMUM: "The rounded amount is below the minimum hedge amount.",
  NO_RATE: "The spot rate needed to convert the minimum or maximum hedge amount, or the amount threshold, is missing.",
  NO_TRADING_ENTITY: "This netting group has no entity. Configure a default trading entity in the hedge policy to get a recommendation for it.",
};

/** Why a currency's business-day calendar could not be fully relied on for a recommendation's dates (decision 0014). The dates then treat only Saturdays and Sundays as non-business days for that currency. */
export type CalendarGapReason = "NO_CALENDAR" | "CALENDAR_ENDED";
export interface CalendarGap {
  readonly currency: string;
  readonly reason: CalendarGapReason;
}
export const CALENDAR_GAP_MESSAGES: Readonly<Record<CalendarGapReason, string>> = {
  NO_CALENDAR: "No business-day calendar is loaded for this currency, so only Saturdays and Sundays were treated as non-business days.",
  CALENDAR_ENDED: "The holidays loaded for this currency end before the value date, so later holidays are not taken into account.",
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
  /** The target ratio; null for the amount-threshold strategy, which has none. */
  readonly ratio: string | null;
  /** The amount threshold the net exposure was compared with, in the exposure currency; null for the hedge-ratio-adjustment strategy. */
  readonly thresholdExposureAmount: string | null;
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
  /** Currencies whose calendar was missing or too short for the value date. Empty when there is no value date or every calendar covered it. */
  readonly calendarGaps: readonly CalendarGap[];
  readonly status: RecommendationStatus;
  readonly decidedAmount: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** The pre-trade of the first part, once the decision has one (the only one when the hedge is not split); see `parts`. */
  readonly preTradeId: string | null;
  /** The maximum in the exposure currency that applied; null when there was none. */
  readonly maxExposureAmount: string | null;
  readonly splitMethod: SplitMethod | null;
  /** Set when the split was adjusted so no part falls below the minimum. */
  readonly splitNote: string | null;
  /** The pieces of the hedge, in order; one when it is not split. After a decision they are the amounts of the pre-trades. Empty when there is no action. */
  readonly parts: readonly RecommendationPart[];
  /** Of the whole: executed when every part is, partly executed once any part is, cancelled when every part is. */
  readonly followUp: FollowUp;
}

export interface RecommendationPart {
  readonly partNo: number;
  /** Positive, in the exposure currency. */
  readonly amount: string;
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
  /** Who currently has an Approve Cycle in flight on the cycle under segregation of duties (decision 0013), as actor labels, each once. Cleared when the cycle is approved, skipped or deleted. */
  approvalHolds(tenantId: TenantId, cycleId: CycleId): Promise<readonly string[]>;
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
/** A decision made a pre-trade in FX Trade: one event per part. */
export interface PreTradeCreated extends Announcement {
  readonly type: "hedge-recommendation.pre-trade-created";
  readonly recommendationId: string;
  readonly preTradeId: string;
  /** Which part of the recommendation this pre-trade is, from 1 (decision 0016). */
  readonly partNo: number;
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
