// Pure rate arithmetic. Rates are decimal strings with 10 places.
import { Decimal } from "decimal.js";
import type { Derivation, RateQuality } from "../contract/index.ts";

Decimal.set({ precision: 40 });
const PLACES = 10;
export const fix = (d: Decimal): string => d.toDecimalPlaces(PLACES, Decimal.ROUND_HALF_UP).toFixed(PLACES);

export const invert = (rate: string): string => fix(new Decimal(1).div(rate));
export const multiply = (a: string, b: string): string => fix(new Decimal(a).times(b));

/** The weakest of the qualities that went into a derived rate. */
export function weakest(qualities: readonly RateQuality[]): RateQuality {
  if (qualities.includes("STALE")) return "STALE";
  if (qualities.includes("OUTLIER")) return "OUTLIER";
  return "VALID";
}

export interface Leg {
  readonly rate: string;
  readonly derivation: Extract<Derivation, "DIRECT" | "INVERSE">;
}

const legValue = (leg: Leg): Decimal => (leg.derivation === "INVERSE" ? new Decimal(1).div(leg.rate) : new Decimal(leg.rate));

/** A leg as a rate: used directly, or inverted. */
export const legRate = (leg: Leg): string => fix(legValue(leg));

/** Cross rate base/quote through a pivot from base/pivot and pivot/quote. Rounded once, at the end. */
export const cross = (first: Leg, second: Leg): string => fix(legValue(first).times(legValue(second)));
