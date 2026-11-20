// The hedge-ratio-adjustment calculation and the date rules. Pure: no database, no clock (decision 0011).
import { Decimal } from "decimal.js";
import type { NoActionReason, SplitMethod } from "../contract/index.ts";

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

/** The most parts one hedge is split into; beyond it the pieces are made larger than the maximum rather than create more trades (decision 0016). */
export const MAX_PARTS = 50;
const SMALLEST = new D("0.0001");

export interface Split {
  /** Positive, in order; they add up to the total. */
  readonly parts: Num[];
  /** Why the pieces differ from the plain split, when they do. */
  readonly note: string | null;
}

/**
 * Split an amount above the maximum into n = roundup(total / maximum) pieces (decision 0016). Pieces are whole steps of the rounding when the total is.
 * EVEN: equal pieces, the leftover steps going to the first pieces (450 at a maximum of 200: 150, 150, 150).
 * THRESHOLD_REMAINDER: pieces of the maximum (rounded down to a step) and one piece for what is left (200, 200, 50). A last piece below the minimum is
 * added to the one before it. With EVEN, pieces below the minimum make it use one piece fewer, until none is.
 * Whatever the method, the pieces are positive, add up exactly to the total, number at most MAX_PARTS, and cannot be finer than one step. Where that makes
 * a piece larger than the maximum the note says why. No maximum, or a total within it, is one piece.
 */
export function splitAmount(total: Num, maximum: Num | null, method: SplitMethod, step: Num, minimum: Num | null): Split {
  if (maximum === null || total.lte(maximum)) return { parts: [total], note: null };
  const unit = total.mod(step).isZero() ? step : SMALLEST;
  const units = total.div(unit).floor().toNumber(); // the total in whole units: no piece can be smaller than one
  const cap = Math.min(MAX_PARTS, units);
  const even = (n: number): Num[] => {
    const base = total.div(n).div(unit).floor().times(unit);
    const extra = total.minus(base.times(n)).div(unit).toNumber();
    return Array.from({ length: n }, (_, i) => (i < extra ? base.plus(unit) : base));
  };
  const wanted = total.div(maximum).ceil().toNumber();
  const notes: string[] = [];
  const capNote = (n: number): string =>
    n === MAX_PARTS && units > MAX_PARTS ? `Split into ${MAX_PARTS} parts, the most allowed, so the parts are larger than the maximum.`
      : `The amount is only ${units} whole step${units === 1 ? "" : "s"} of ${unit.toString()}, so it was split into ${n} part${n === 1 ? "" : "s"}, larger than the maximum.`;
  let parts: Num[];
  if (method === "EVEN") {
    let n = Math.min(wanted, cap);
    if (n < wanted) notes.push(capNote(n));
    parts = even(n);
    const before = n;
    while (n > 1 && minimum !== null && parts.some((x) => x.lt(minimum))) parts = even(--n);
    if (n < before) notes.push("Fewer parts than the maximum calls for, because the equal parts were below the minimum hedge amount.");
  } else {
    const piece = maximum.div(unit).floor().times(unit);
    if (piece.isZero()) {
      parts = [total];
      notes.push("The maximum is smaller than the smallest amount that can be traded, so the hedge was not split.");
    } else {
      const full = total.div(piece).floor().toNumber();
      const rest = total.minus(piece.times(full));
      parts = Array.from({ length: full }, () => piece);
      if (!rest.isZero()) {
        if (minimum !== null && rest.lt(minimum) && full >= 1) {
          parts[full - 1] = piece.plus(rest);
          notes.push("The last part was below the minimum hedge amount, so it was added to the part before it.");
        } else parts.push(rest);
      }
      if (parts.length > cap) {
        parts = even(cap);
        notes.length = 0;
        notes.push(capNote(cap));
      }
    }
  }
  if (parts.some((x) => !x.gt(0)) || !parts.reduce((s, x) => s.plus(x), new D(0)).eq(total) || parts.length > MAX_PARTS) {
    throw new Error(`splitting ${total.toString()} at a maximum of ${maximum.toString()} gave parts that are not positive, do not add up, or are too many`);
  }
  if (notes.length === 0 && parts.some((x) => x.gt(maximum))) notes.push(`Some parts are larger than the maximum, because amounts are traded in whole steps of ${unit.toString()}.`);
  return { parts, note: notes.length === 0 ? null : notes.join(" ") };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (s: string): Date => new Date(`${s}T00:00:00Z`);
/** One currency's business days (decision 0014). `coveredThrough` is null when no calendar is on record. Beyond it, only Saturdays and Sundays are non-business days. */
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

const DEFAULT_WEEKEND: ReadonlySet<number> = new Set([0, 6]);

/**
 * Is the currency open on the date? Only a day the calendar covers is judged by it. On a day after its covered-through date (or with no calendar at all)
 * the calendar is not trusted, weekend days included: only Saturdays and Sundays are closed there (decision 0014).
 */
const openOn = (c: BusinessCalendar, date: string, day: number): boolean => {
  if (c.coveredThrough === null || date > c.coveredThrough) return !DEFAULT_WEEKEND.has(day);
  return !c.weekend.has(day) && !c.holidays.has(date);
};

/** A day on which every one of the calendars is open. */
export const isBusinessDay = (date: string, cals: readonly BusinessCalendar[]): boolean => {
  const day = utc(date).getUTCDay();
  return cals.every((c) => openOn(c, date, day));
};

function step(date: string, by: 1 | -1, cals: readonly BusinessCalendar[]): string {
  const d = utc(date);
  for (let i = 0; i < LIMIT; i++) {
    if (isBusinessDay(iso(d), cals)) return iso(d);
    d.setUTCDate(d.getUTCDate() + by);
  }
  throw new Error(`no business day within ${LIMIT} days of ${date} on the calendars of ${cals.map((c) => c.currency).join(", ")}`);
}

/**
 * Modified following: the next business day on all the calendars, unless that is in another month, in which case the last one before.
 * `through` is the latest day looked at, which is what a calendar must cover for the answer to be fully trusted.
 */
export function rollWithSpan(date: string, cals: readonly BusinessCalendar[]): { date: string; through: string } {
  const forward = step(date, 1, cals);
  return forward.slice(0, 7) === date.slice(0, 7) ? { date: forward, through: forward } : { date: step(date, -1, cals), through: forward };
}
export const rollModifiedFollowing = (date: string, cals: readonly BusinessCalendar[]): string => rollWithSpan(date, cals).date;

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
/** The calendars that could not be fully trusted for the days looked at, up to `through`: none on record, or covered only to an earlier date. */
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
