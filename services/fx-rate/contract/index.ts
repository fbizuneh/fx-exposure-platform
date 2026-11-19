// Published questions and events of FX Rate. Other services import this file, never src/.
import type { AsOfDate, TenantId } from "@shared/kernel";

export const RATE_QUALITIES = ["VALID", "STALE", "OUTLIER"] as const;
export type RateQuality = (typeof RATE_QUALITIES)[number];
export const DERIVATIONS = ["DIRECT", "INVERSE", "CROSS", "IDENTITY"] as const;
export type Derivation = (typeof DERIVATIONS)[number];

/** Tenor is "SPOT" or a code such as "1W", "1M", "3M". */
export interface RateQuery {
  readonly tenantId: TenantId;
  /** One unit of base is worth `rate` units of quote. */
  readonly base: string;
  readonly quote: string;
  readonly asOf: AsOfDate;
  readonly tenor?: string;
  /** Overrides the tenant's preferred source. */
  readonly source?: string;
}

export interface Rate {
  readonly base: string;
  readonly quote: string;
  readonly tenor: string;
  readonly asOf: AsOfDate;
  /** A decimal string with up to 10 places. */
  readonly rate: string;
  readonly derivation: Derivation;
  /** Anything but VALID means the caller must decide whether to use it. A derived rate shows its weakest part. */
  readonly quality: RateQuality;
  /** Null for the identity rate. */
  readonly source: string | null;
  /** The loads the rate came from, so a run can record where it was drawn. */
  readonly loadIds: readonly string[];
}

export interface FxRateQuestions {
  /** The rate for a pair, date and tenor, or null when the date has none. */
  getRate(query: RateQuery): Promise<Rate | null>;
}

/** One event per accepted load. It carries identifiers only. */
export interface RatesLoaded {
  readonly type: "fx-rate.loaded";
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly loadId: string;
  readonly source: string;
  readonly businessDate: AsOfDate;
}
export type FxRateEvents = RatesLoaded;
