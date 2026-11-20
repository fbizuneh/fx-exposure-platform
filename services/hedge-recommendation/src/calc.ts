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
/** One currency's business days (decision 0014). `coveredThrough` is null when no calendar is on record: only Saturdays and Sundays are then non-business days. */
export interface BusinessCalendar {
  readonly currency: string;
  /** Days of the week that are not business days, as `Date#getUTCDay` numbers (0 is Sunday). */
  readonly weekend: ReadonlySet<number>;
  readonly holidays: ReadonlySet<string>;
  readonly coveredThrough: string | null;
}
const DAY_NUMBER: Readonly<Record<string, number>> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
export const noCalendar = (currency: string): BusinessCalendar => ({ currency, weekend: new Set([0, 6]), holidays: new Set(), coveredThrough: null });
export const toBusinessCalendar = (c: { currency: string; weekendDays: readonly string[]; coveredThrough: string; holidays: readonly { date: string }[] }): BusinessCalendar => ({
  currency: c.currency, weekend: new Set(c.weekendDays.map((d) => DAY_NUMBER[d]!)), holidays: new Set(c.holidays.map((h) => h.date)), coveredThrough: c.coveredThrough,
});

const LIMIT = 400; // no real calendar goes this long without a business day; stops a bad calendar looping forever

/** A day on which every one of the calendars is open. */
export const isBusinessDay = (date: string, cals: readonly BusinessCalendar[]): boolean => {
  const day = utc(date).getUTCDay();
  return cals.every((c) => !c.weekend.has(day) && !c.holidays.has(date));
};

function step(date: string, by: 1 | -1, cals: readonly BusinessCalendar[]): string {
  const d = utc(date);
  for (let i = 0; i < LIMIT; i++) {
    if (isBusinessDay(iso(d), cals)) return iso(d);
    d.setUTCDate(d.getUTCDate() + by);
  }
  throw new Error(`no business day within ${LIMIT} days of ${date} on the calendars of ${cals.map((c) => c.currency).join(", ")}`);
}

/** Modified following: the next business day on all the calendars, unless that is in another month, in which case the last one before. */
export function rollModifiedFollowing(date: string, cals: readonly BusinessCalendar[]): string {
  const forward = step(date, 1, cals);
  return forward.slice(0, 7) === date.slice(0, 7) ? forward : step(date, -1, cals);
}

/** The business day `count` business days before the date, counting only days open on every calendar. */
export function businessDaysBefore(date: string, count: number, cals: readonly BusinessCalendar[]): string {
  const d = utc(date);
  for (let left = count, guard = 0; left > 0; ) {
    if (++guard > LIMIT * Math.max(count, 1)) throw new Error(`no business days before ${date}`);
    d.setUTCDate(d.getUTCDate() - 1);
    if (isBusinessDay(iso(d), cals)) left--;
  }
  return iso(d);
}

export type CalendarGapReason = "NO_CALENDAR" | "CALENDAR_ENDED";
/** The calendars that could not be trusted for a date: none on record, or holidays known only up to an earlier date. */
export function calendarGaps(cals: readonly BusinessCalendar[], through: string): { currency: string; reason: CalendarGapReason }[] {
  const out: { currency: string; reason: CalendarGapReason }[] = [];
  for (const c of cals) {
    if (c.coveredThrough === null) out.push({ currency: c.currency, reason: "NO_CALENDAR" });
    else if (c.coveredThrough < through) out.push({ currency: c.currency, reason: "CALENDAR_ENDED" });
  }
  return out;
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

/** Value date for a recommendation: as-of plus tenor, rolled (modified following) to a day open in both currencies of the pair (decision 0014). */
export const valueDateFor = (asOf: string, tenor: string, cals: readonly BusinessCalendar[]): string => rollModifiedFollowing(addTenor(asOf, tenor), cals);

/** Decimal string with at least two places, up to four, no trailing zeros beyond two. */
export const fmt = (d: Num): string => {
  const s = d.toDecimalPlaces(4).toFixed(4);
  return /\.\d{2}00$/.test(s) ? s.slice(0, -2) : s;
};

/** A pair without regard to which currency is written first: "USD-EUR" and "EUR-USD" are the same pair for a ratio. */
export const pairKey = (pair: string): string => pair.split("-").sort().join("-");
