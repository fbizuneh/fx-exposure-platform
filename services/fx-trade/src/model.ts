// Plain shapes and rules shared inside FX Trade. No database here.
import type { Direction, Instrument, LegRole } from "../contract/index.ts";
import { INSTRUMENTS } from "../contract/index.ts";

export interface LegInput {
  readonly role: LegRole;
  readonly direction: Direction;
  readonly dealCurrency: string;
  readonly dealAmount: string;
  readonly settlementCurrency: string;
  readonly settlementAmount: string | null;
  readonly valueDate: string;
  readonly fixingDate: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const realDate = (v: string): boolean => ISO.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const CCY = /^[A-Z]{3}$/;
const AMOUNT = /^\d{1,24}(\.\d{1,4})?$/;

/** "100" and "100.0000" are the same amount; keep four places so comparisons and storage agree. */
export function fixed4(v: string): string {
  const [i = "0", f = ""] = v.split(".");
  return `${i.replace(/^0+(?=\d)/, "")}.${(f + "0000").slice(0, 4)}`;
}
const isPositive = (v: string): boolean => AMOUNT.test(v) && /[1-9]/.test(v);

/** Problems with a trade's legs, as plain sentences. An empty list means the shape is sound. */
export function legProblems(instrument: Instrument, legs: readonly LegInput[], needSettlementAmount: boolean): string[] {
  const out: string[] = [];
  if (!INSTRUMENTS.includes(instrument)) return [`instrument "${instrument}" is not one of ${INSTRUMENTS.join(", ")}`];
  const roles = legs.map((l) => l.role).join(",");
  if (instrument === "SWAP" ? roles !== "NEAR,FAR" : roles !== "SINGLE") {
    out.push(instrument === "SWAP" ? "a swap needs a near leg and a far leg" : `a ${instrument.toLowerCase()} has one leg`);
    return out;
  }
  legs.forEach((l, i) => {
    const at = legs.length > 1 ? ` (${l.role.toLowerCase()} leg)` : "";
    if (l.direction !== "BUY" && l.direction !== "SELL") out.push(`direction${at} must be BUY or SELL`);
    if (!CCY.test(l.dealCurrency) || !CCY.test(l.settlementCurrency)) out.push(`currencies${at} must be three capital letters`);
    else if (l.dealCurrency === l.settlementCurrency) out.push(`deal and settlement currency${at} must differ`);
    if (!isPositive(l.dealAmount)) out.push(`deal amount${at} must be a positive number with up to 4 decimals`);
    if (l.settlementAmount === null ? needSettlementAmount : !isPositive(l.settlementAmount)) out.push(`settlement amount${at} must be a positive number with up to 4 decimals`);
    if (!realDate(l.valueDate)) out.push(`value date${at} is not a date`);
    if (instrument === "NDF") {
      if (l.fixingDate === null || !realDate(l.fixingDate)) out.push("an NDF needs a fixing date");
      else if (realDate(l.valueDate) && l.fixingDate > l.valueDate) out.push("the fixing date cannot be after the value date");
    } else if (l.fixingDate !== null) out.push("only an NDF has a fixing date");
    void i;
  });
  if (instrument === "SWAP" && legs.length === 2) {
    const [near, far] = legs as [LegInput, LegInput];
    if (near.dealCurrency !== far.dealCurrency || near.settlementCurrency !== far.settlementCurrency) out.push("both swap legs must use the same currency pair");
    if (near.direction === far.direction) out.push("a swap's legs go in opposite directions");
    if (realDate(near.valueDate) && realDate(far.valueDate) && near.valueDate >= far.valueDate) out.push("the far leg must be later than the near leg");
  }
  return out;
}

/** What a trade's legs must share with a pre-trade for it to be the same trade: everything but amounts. */
const shape = (l: LegInput): string => `${l.role}|${l.direction}|${l.dealCurrency}|${l.settlementCurrency}|${l.valueDate}`;

export interface MatchSubject {
  readonly programId: string | null;
  readonly tradingEntityCode: string;
  readonly instrument: Instrument;
  readonly legs: readonly LegInput[];
}
export interface OpenPreTrade {
  readonly preTradeId: string;
  readonly reference: string;
  readonly programId: string;
  readonly tradingEntityCode: string;
  readonly instrument: Instrument;
  readonly legs: readonly LegInput[];
  /** Deal amount still to fill (swaps: all or nothing). */
  readonly remaining: string;
}

const toUnits = (v: string): bigint => BigInt(fixed4(v).replace(".", ""));

/** Why a pre-trade does not fit, or null when it does. */
export function misfit(t: MatchSubject, p: OpenPreTrade): string | null {
  if (t.programId !== p.programId) return `program ${t.programId ?? "(none)"} is not ${p.programId}`;
  if (t.tradingEntityCode !== p.tradingEntityCode) return `entity ${t.tradingEntityCode} is not ${p.tradingEntityCode}`;
  if (t.instrument !== p.instrument) return `instrument ${t.instrument} is not ${p.instrument}`;
  if (t.legs.length !== p.legs.length || t.legs.some((l, i) => shape(l) !== shape(p.legs[i]!))) return "direction, currencies or value dates differ";
  if (t.instrument === "SWAP") {
    return t.legs.every((l, i) => toUnits(l.dealAmount) === toUnits(p.legs[i]!.dealAmount)) && toUnits(p.remaining) > 0n ? null : "a swap must fill the whole pre-trade";
  }
  return toUnits(t.legs[0]!.dealAmount) <= toUnits(p.remaining) ? null : `amount ${fixed4(t.legs[0]!.dealAmount)} is more than the ${fixed4(p.remaining)} still open`;
}

export interface MatchResult {
  readonly status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS";
  readonly preTradeId: string | null;
  readonly note: string | null;
  readonly candidates: readonly string[];
}

/**
 * Decision 0009 (7). A reference is tried first and must fit. With no reference, exactly one open pre-trade
 * must fit. `byReference` is the pre-trade the reference names, if any (open or not).
 */
export function matchTrade(t: MatchSubject, reference: string | null, byReference: OpenPreTrade | null, open: readonly OpenPreTrade[]): MatchResult {
  if (t.programId === null) return { status: "UNMATCHED", preTradeId: null, note: "the file gives no program, or one that is not in the catalog", candidates: [] };
  if (reference !== null) {
    if (byReference === null) return { status: "UNMATCHED", preTradeId: null, note: `no open pre-trade has the reference ${reference}`, candidates: [] };
    const why = misfit(t, byReference);
    return why === null
      ? { status: "MATCHED", preTradeId: byReference.preTradeId, note: null, candidates: [] }
      : { status: "UNMATCHED", preTradeId: null, note: `the pre-trade ${reference} does not fit: ${why}`, candidates: [byReference.preTradeId] };
  }
  const fits = open.filter((p) => misfit(t, p) === null);
  if (fits.length === 1) return { status: "MATCHED", preTradeId: fits[0]!.preTradeId, note: null, candidates: [] };
  if (fits.length === 0) return { status: "UNMATCHED", preTradeId: null, note: "no open pre-trade fits", candidates: [] };
  return { status: "AMBIGUOUS", preTradeId: null, note: `${fits.length} open pre-trades fit`, candidates: fits.map((p) => p.preTradeId).sort() };
}

export const units = (v: string): bigint => toUnits(v);
export function fromUnits(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(5, "0");
  return `${neg ? "-" : ""}${s.slice(0, -4)}.${s.slice(-4)}`;
}
