// The hedge-ratio-adjustment calculation and the date rules. Pure: no database, no clock (decision 0011).
import { Decimal } from "decimal.js";
import type { NoActionReason } from "../contract/index.ts";

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Num = InstanceType<typeof D>;

/** Round an amount toward zero to a multiple of the step: 234,430 at 1,000 is 234,000. */
export function roundDownToStep(amount: Num, step: Num): Num {
  return amount.abs().div(step).floor().times(step).times(amount.isNegative() ? -1 : 1);
}

export interface Needed {
  readonly grossExposure: string;
  readonly hedgedAmount: string;
  readonly ratio: string;
  readonly rounding: string;
  /** The minimum in the exposure currency; null when the program sets none. */
  readonly minExposure: string | null;
  /** The minimum is set but the rate to convert it is missing. */
  readonly rateMissing: boolean;
}
export interface Outcome {
  readonly target: Num;
  readonly needed: Num;
  readonly action: "HEDGE" | "NONE";
  readonly reason: NoActionReason | null;
  readonly direction: "BUY" | "SELL" | null;
  /** Positive, rounded down to the step. */
  readonly amount: Num | null;
}

/**
 * Target hedge = minus ratio times gross exposure (a hedge against a long exposure is a sale). Needed = target minus what is already hedged.
 * The needed amount is rounded down to the step and then tested against the minimum, both in the exposure currency.
 */
export function recommend(n: Needed): Outcome {
  const target = new D(n.grossExposure).times(n.ratio).negated();
  const needed = target.minus(n.hedgedAmount);
  const none = (reason: NoActionReason): Outcome => ({ target, needed, action: "NONE", reason, direction: null, amount: null });
  if (needed.isZero()) return none("WITHIN_TARGET");
  if (n.rateMissing) return none("NO_RATE");
  const rounded = roundDownToStep(needed, new D(n.rounding)).abs();
  if (rounded.isZero()) return none("ROUNDS_TO_ZERO");
  if (n.minExposure !== null && rounded.lt(n.minExposure)) return none("BELOW_MINIMUM");
  return { target, needed, action: "HEDGE", direction: needed.isNegative() ? "SELL" : "BUY", amount: rounded, reason: null };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (s: string): Date => new Date(`${s}T00:00:00Z`);
const isWeekend = (d: Date): boolean => d.getUTCDay() === 0 || d.getUTCDay() === 6;

export function weekdayOnOrAfter(date: string): string {
  const d = utc(date);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

export function weekdaysBefore(date: string, count: number): string {
  const d = utc(date);
  for (let left = count; left > 0; ) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!isWeekend(d)) left--;
  }
  return iso(d);
}

export const TENOR = /^([1-9]\d?)([WM])$/;

/** The as-of date plus the tenor ("1M", "2W"): months keep the day or clamp to the month's end. Not yet rolled to a business day. */
export function addTenor(asOf: string, tenor: string): string {
  const m = TENOR.exec(tenor);
  if (!m) throw new Error(`unsupported tenor ${tenor}`);
  const n = Number(m[1]);
  const d = utc(asOf);
  if (m[2] === "W") { d.setUTCDate(d.getUTCDate() + 7 * n); return iso(d); }
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}

/** Value date for a recommendation: as-of plus tenor, rolled forward to a weekday (calendars are a follow-up, decision 0011 item 8). */
export const valueDateFor = (asOf: string, tenor: string): string => weekdayOnOrAfter(addTenor(asOf, tenor));

/** Decimal string with at least two places, up to four, no trailing zeros beyond two. */
export const fmt = (d: Num): string => {
  const s = d.toDecimalPlaces(4).toFixed(4);
  return /\.\d{2}00$/.test(s) ? s.slice(0, -2) : s;
};
