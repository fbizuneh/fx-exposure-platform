// Checks on a load before anything is written. A load with any problem is refused whole.
import { Decimal } from "decimal.js";
import type { RateQuality } from "../contract/index.ts";
import type { RateRow } from "./rows.ts";

export class RatesInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`rate load is invalid: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}`);
    this.problems = problems;
  }
}

const CURRENCY = /^[A-Z]{3}$/;
const TENOR = /^[1-9][0-9]{0,2}[DWMY]$/;
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TOLERANCE = new Decimal("0.0000000001");
export const DEFAULT_OUTLIER_SHARE = 0.1;

/** Fits NUMERIC(20,10): at most 10 places and 10 digits before the point. */
function fits(v: string): boolean {
  const [whole = "", frac = ""] = v.split(".");
  return whole.replace(/^0+(?=\d)/, "").length <= 10 && frac.length <= 10;
}

function checkNumber(label: string, v: string | null, out: string[], where: string): Decimal | null {
  if (v === null) return null;
  if (!NUMBER.test(v) || !fits(v)) {
    out.push(`${where}: ${label} must be a positive number with at most 10 places`);
    return null;
  }
  const d = new Decimal(v);
  if (d.lte(0)) out.push(`${where}: ${label} must be positive`);
  return d;
}

export function rowKey(r: Pick<RateRow, "base" | "quote" | "tenor">): string {
  return `${r.base}/${r.quote}/${r.tenor}`;
}

export function validateRates(rows: readonly RateRow[], businessDate: string, now: Date): string[] {
  const out: string[] = [];
  if (!ISO_DATE.test(businessDate) || Number.isNaN(Date.parse(businessDate))) out.push(`business date ${businessDate} is not a date`);
  else if (new Date(`${businessDate}T00:00:00Z`).getTime() > now.getTime()) out.push(`business date ${businessDate} is in the future`);
  if (rows.length === 0) out.push("a load must contain at least one rate");
  const seen = new Set<string>();
  for (const r of rows) {
    const where = `${r.base}/${r.quote} ${r.tenor}`;
    if (!CURRENCY.test(r.base) || !CURRENCY.test(r.quote)) out.push(`${where}: currencies must be three capital letters`);
    else if (r.base === r.quote) out.push(`${where}: the two currencies must differ`);
    if (r.type !== "SPOT" && r.type !== "FORWARD") out.push(`${where}: type must be SPOT or FORWARD`);
    if (r.type === "SPOT") {
      if (r.tenor !== "SPOT") out.push(`${where}: a spot rate has tenor SPOT`);
      if (r.valueDate || r.spot || r.forwardPoints) out.push(`${where}: a spot rate cannot carry a value date, spot or forward points`);
    } else if (r.type === "FORWARD" && !TENOR.test(r.tenor)) {
      out.push(`${where}: a forward needs a tenor code such as 1W, 1M or 3M`);
    }
    if (r.valueDate !== null && (!ISO_DATE.test(r.valueDate) || Number.isNaN(Date.parse(r.valueDate)))) out.push(`${where}: value date is not a date`);
    const allIn = checkNumber("all-in rate", r.allIn, out, where);
    const spot = checkNumber("spot", r.spot, out, where);
    const bid = checkNumber("bid", r.bid, out, where);
    checkNumber("mid", r.mid, out, where);
    const ask = checkNumber("ask", r.ask, out, where);
    let points: Decimal | null = null;
    if (r.forwardPoints !== null) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(r.forwardPoints) || !fits(r.forwardPoints.replace(/^[+-]/, ""))) out.push(`${where}: forward points must be a number with at most 10 places`);
      else points = new Decimal(r.forwardPoints);
    }
    if (bid && ask && bid.gt(ask)) out.push(`${where}: bid cannot exceed ask`);
    if (r.type === "FORWARD" && allIn && spot && points && spot.plus(points).minus(allIn).abs().gt(TOLERANCE)) {
      out.push(`${where}: spot plus forward points must equal the all-in rate`);
    }
    const observed = Date.parse(r.observedAt);
    if (Number.isNaN(observed)) out.push(`${where}: observation time is not a timestamp`);
    else if (observed > now.getTime()) out.push(`${where}: observation is in the future`);
    const key = rowKey(r);
    if (seen.has(key)) out.push(`${where} appears twice`);
    seen.add(key);
  }
  return out;
}

/**
 * The quality a rate is stored with. Stale outranks outlier. Age is measured to the end of the business date,
 * not to the processing day, because a file for an earlier date may be loaded later.
 */
export function qualityOf(observedAt: Date, endOfBusinessDate: Date, staleAfterMinutes: number | null, allIn: string, prior: string | null, outlierShare: number): RateQuality {
  if (staleAfterMinutes !== null && (endOfBusinessDate.getTime() - observedAt.getTime()) / 60000 > staleAfterMinutes) return "STALE";
  if (prior !== null && new Decimal(allIn).div(prior).minus(1).abs().gt(outlierShare)) return "OUTLIER";
  return "VALID";
}
