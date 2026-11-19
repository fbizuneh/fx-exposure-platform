// Published questions and events of FX Trade. Other services import this file, never src/.
import type { AsOfDate, CycleId, ProgramId, TenantId } from "@shared/kernel";

export const INSTRUMENTS = ["SPOT", "FORWARD", "NDF", "SWAP"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export type Direction = "BUY" | "SELL";
export type LegRole = "SINGLE" | "NEAR" | "FAR";
export const PRE_TRADE_STATUSES = ["DRAFT", "READY", "SENT", "PARTLY_EXECUTED", "EXECUTED", "CANCELLED"] as const;
export type PreTradeStatus = (typeof PRE_TRADE_STATUSES)[number];
export type MatchStatus = "MATCHED" | "UNMATCHED" | "AMBIGUOUS";

/** Amounts are decimal strings with up to 4 places. Direction is buy or sell of the deal currency. */
export interface TradeLeg {
  readonly legNo: number;
  readonly role: LegRole;
  readonly direction: Direction;
  readonly dealCurrency: string;
  readonly dealAmount: string;
  readonly settlementCurrency: string;
  /** Always present on an executed trade; may be absent on a pre-trade, which has no price yet. */
  readonly settlementAmount: string | null;
  readonly valueDate: string;
  /** NDF only. */
  readonly fixingDate: string | null;
}

export interface PreTrade {
  readonly preTradeId: string;
  readonly reference: string;
  readonly programId: ProgramId;
  readonly cycleId: CycleId | null;
  readonly recommendationId: string | null;
  readonly origin: "RECOMMENDATION" | "MANUAL";
  readonly status: PreTradeStatus;
  readonly tradingEntityCode: string;
  readonly instrument: Instrument;
  readonly legs: readonly TradeLeg[];
  /** Total deal amount already filled by matched, live executed trades. */
  readonly filledAmount: string;
}

export interface ExecutedTrade {
  readonly executedTradeId: string;
  readonly platform: string;
  readonly tradeId: string;
  readonly version: number;
  readonly cancelled: boolean;
  /** Null when the file gave none or one the catalog does not know; such a trade is unmatched. */
  readonly programId: ProgramId | null;
  readonly tradingEntityCode: string;
  readonly counterparty: string | null;
  readonly tradeDate: AsOfDate;
  readonly instrument: Instrument;
  readonly portfolio: string | null;
  readonly legs: readonly (TradeLeg & { readonly settlementAmount: string })[];
  readonly customFields: Readonly<Record<string, string>>;
  readonly matchStatus: MatchStatus;
  readonly preTradeId: string | null;
  readonly matchNote: string | null;
  /** Pre-trade IDs that could have been the match, for a user to choose from. */
  readonly candidates: readonly string[];
  readonly batchId: string | null;
}

export interface TradeIssue {
  readonly batchId: string;
  readonly rowNo: number;
  readonly code: string;
  readonly message: string;
}

export interface FxTradeQuestions {
  preTrades(
    tenantId: TenantId,
    filter?: { readonly cycleId?: CycleId; readonly programId?: ProgramId; readonly status?: PreTradeStatus },
  ): Promise<readonly PreTrade[]>;
  getPreTrade(tenantId: TenantId, preTradeId: string): Promise<PreTrade | null>;
  /**
   * Live executed trades of a program that are open on the date: traded on or before it and with a last
   * value date after it. Current versions only.
   */
  executedTrades(tenantId: TenantId, query: { readonly programId: ProgramId; readonly asOf: AsOfDate }): Promise<readonly ExecutedTrade[]>;
  /** Current executed trades that are unmatched or ambiguous, with or without a program. */
  unmatchedTrades(tenantId: TenantId, filter?: { readonly programId?: ProgramId }): Promise<readonly ExecutedTrade[]>;
  tradeIssues(tenantId: TenantId, batchId?: string): Promise<readonly TradeIssue[]>;
}

interface Announcement {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}
/** A pre-trade is ready to go out: a cycle was approved, or a user released a manual one. */
export interface PreTradeReady extends Announcement {
  readonly type: "fx-trade.pre-trade-ready";
  readonly preTradeId: string;
  readonly programId: ProgramId;
  readonly cycleId: CycleId | null;
}
/** An executed trade (or a new version of one) was stored. */
export interface ExecutedTradeReceived extends Announcement {
  readonly type: "fx-trade.executed-trade-received";
  readonly executedTradeId: string;
  readonly programId: ProgramId | null;
  readonly preTradeId: string | null;
}
export type FxTradeEvents = PreTradeReady | ExecutedTradeReceived;
