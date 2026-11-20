// Published questions and events of Hedge Recommendation. Other services import this file, never src/.
import type { ChangeRecordFields } from "@services/audit/contract";
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";

export const STRATEGIES = ["hedge-ratio-adjustment", "amount-threshold"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * NONE: no roll. ADJUST_SWAP: maturing hedges are rolled to the far date and the adjustment is made at the far date (decision 0021).
 * CLOSE_OUT_NEW: maturing hedges are closed and the new hedges at the far date are what the rule gives on the hedges that remain (decision 0022).
 */
export const ROLL_TYPES = ["NONE", "ADJUST_SWAP", "CLOSE_OUT_NEW"] as const;
export type RollType = (typeof ROLL_TYPES)[number];
/** SEPARATE: the close-outs, the roll and the adjustment are separate trades. COMBINED: the roll and the adjustment are one trade at the far date. Used by ADJUST_SWAP only. */
export const ROLL_ADJUSTMENTS = ["SEPARATE", "COMBINED"] as const;
export type RollAdjustment = (typeof ROLL_ADJUSTMENTS)[number];

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
  /** The amount threshold in the display currency: the net exposure must be at or above it for a hedge to be recommended. Required for the amount-threshold strategy. */
  readonly amountThresholdDisplay: string | null;
  /** A different threshold for the groups of a netting level; it replaces the program's threshold for them. */
  readonly amountThresholdOverrides: readonly { readonly nettingLevel: string; readonly amountThresholdDisplay: string }[];
  /** NONE unless the program rolls maturing hedges (decision 0021). The decision rule above (ratio or amount threshold) still decides the adjustment. */
  readonly rollType: RollType;
  /** How the adjustment is booked next to the roll. */
  readonly rollAdjustment: RollAdjustment;
  /** Calendar days added to the near date to select the maturing hedges, unless the cycle's roll dates give their own. */
  readonly rollOffsetDays: number;
  /** False when nothing has been saved and the defaults apply. */
  readonly saved: boolean;
}

/** DECIDING: an accept or override has won and its pre-trade is being made; it ends as accepted, overridden, or back to open if FX Trade refuses. */
export type RecommendationStatus = "OPEN" | "DECIDING" | "ACCEPTED" | "OVERRIDDEN" | "DISMISSED" | "LAPSED" | "SUPERSEDED" | "NONE";
/** EXECUTED_REST_CANCELLED: every part is finished, some executed and some cancelled (decision 0017). Only a whole recommendation has it, never a part. */
export type FollowUp = "NOT_STARTED" | "OPEN" | "PARTLY_EXECUTED" | "EXECUTED" | "EXECUTED_REST_CANCELLED" | "CANCELLED";
export type NoActionReason = "WITHIN_TARGET" | "WITHIN_THRESHOLD" | "ROUNDS_TO_ZERO" | "BELOW_MINIMUM" | "NO_RATE" | "NO_TRADING_ENTITY" | "ROLL_DATES_NOT_SET" | "FAR_DATE_CLOSED";
/** What to tell the user for each reason a group has no actionable recommendation. */
export const NO_ACTION_MESSAGES: Readonly<Record<NoActionReason, string>> = {
  WITHIN_TARGET: "Already hedged to the target ratio.",
  WITHIN_THRESHOLD: "The net exposure is below the amount threshold.",
  ROUNDS_TO_ZERO: "The amount needed is smaller than the rounding step.",
  BELOW_MINIMUM: "The rounded amount is below the minimum hedge amount.",
  NO_RATE: "The spot rate needed to convert the minimum or maximum hedge amount, or the amount threshold, is missing.",
  NO_TRADING_ENTITY: "This netting group has no entity. Configure a default trading entity in the hedge policy to get a recommendation for it.",
  FAR_DATE_CLOSED: "The far date entered for the roll is not a business day in every currency of this pair. Enter another far date (the next joint business day is shown with the recommendation) and rerun the cycle.",
  ROLL_DATES_NOT_SET: "The program rolls maturing hedges, but this cycle has no usable roll dates. Set them (the far date must fall after the near date plus the offset) and rerun the cycle.",
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
  /** Null for a recommendation that was not made by rolling. For a rolled one the direction, amount and value date above are those of the adjustment (of the combined far trade when they are booked as one); the trades to close and roll are in `parts`. */
  readonly roll: RecommendationRoll | null;
  /** Set with the reason FAR_DATE_CLOSED. */
  readonly rollIssue: RollIssue | null;
  readonly parts: readonly RecommendationPart[];
  /** Of the whole: executed when every part is, partly executed once any part is, cancelled when every part is. */
  readonly followUp: FollowUp;
}

/** What a part of a recommendation is (decision 0021): an adjustment, the close-out of the maturing hedges of one value date, the roll that replaces them at the far date, or the roll and the adjustment as one trade; for Close-out+New (decision 0022), a new hedge at the far date. */
export type PartRole = "ADJUSTMENT" | "CLOSE_OUT" | "ROLL" | "COMBINED" | "NEW";

/** The roll dates of a cycle, and what they came to once defaults were filled in. */
export interface RollParameters {
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly nearDate: string;
  /** Null: each group's far date is the policy's tenor date. */
  readonly farDate: string | null;
  /** Null: the policy's default offset. */
  readonly offsetDays: number | null;
  readonly setBy: string;
}

export interface RecommendationRoll {
  readonly type: RollType;
  /** Null for CLOSE_OUT_NEW, which has no adjustment. */
  readonly adjustment: RollAdjustment | null;
  readonly nearDate: string;
  readonly farDate: string;
  readonly offsetDays: number;
}

/** An entered far date that is closed for a currency of the pair: the user chooses a new one; nothing is moved for them (decision 0021). */
export interface RollIssue {
  readonly date: string;
  readonly closedCurrencies: readonly string[];
  /** The next day on which every currency of the pair is open. */
  readonly suggestedDate: string;
}

export interface RecommendationPart {
  readonly partNo: number;
  /** Who books the trade: the recommendation's entity, except a close-out, which the entity holding the maturing hedge books. */
  readonly tradingEntityCode: string | null;
  readonly role: PartRole;
  readonly direction: "BUY" | "SELL" | null;
  /** The part's own value date; for an adjustment, the recommendation's. */
  readonly valueDate: string | null;
  readonly fixingDate: string | null;
  /** Positive, in the exposure currency. */
  readonly amount: string;
  readonly preTradeId: string | null;
  readonly followUp: FollowUp;
}

export interface HedgeRecommendationQuestions {
  /** The saved policy, or the defaults when none is saved. */
  policy(tenantId: TenantId, programId: ProgramId): Promise<HedgePolicy>;
  /** The roll dates entered for the cycle, or null. */
  rollParameters(tenantId: TenantId, cycleId: CycleId): Promise<RollParameters | null>;
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
