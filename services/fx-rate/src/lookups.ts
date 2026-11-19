// The question FX Rate answers: the rate for a pair, date and tenor.
import { sql } from "kysely";
import type { AsOfDate, TenantId } from "@shared/kernel";
import type { Derivation, FxRateQuestions, Rate, RateQuality } from "../contract/index.ts";
import { q, type Db } from "./db.ts";
import { cross, fix, invert, legRate, weakest, type Leg } from "./derive.ts";
import { Decimal } from "decimal.js";

interface Found extends Leg {
  readonly quality: RateQuality;
  readonly source: string;
  readonly loadId: string;
}

async function stored(db: Db, tenant: TenantId, asOf: AsOfDate, base: string, quote: string, tenor: string, source: string | null) {
  let query = q(db).selectFrom("rates").select(["all_in_rate", "quality", "source_code", "load_id"])
    .where("tenant_id", "=", tenant).where("business_date", "=", asOf).where("base_currency", "=", base).where("quote_currency", "=", quote).where("tenor", "=", tenor);
  if (source !== null) query = query.where("source_code", "=", source);
  // A valid rate beats a flagged one; then the latest load wins.
  return query.orderBy(sql`CASE WHEN quality = 'VALID' THEN 0 ELSE 1 END`).orderBy("loaded_at", "desc").orderBy("rate_id").limit(1).executeTakeFirst();
}

/** base/quote as stored, or inverted from quote/base. */
async function leg(db: Db, tenant: TenantId, asOf: AsOfDate, base: string, quote: string, tenor: string, source: string | null): Promise<Found | null> {
  const direct = await stored(db, tenant, asOf, base, quote, tenor, source);
  if (direct) return { rate: direct.all_in_rate, derivation: "DIRECT", quality: direct.quality, source: direct.source_code, loadId: direct.load_id };
  const inverse = await stored(db, tenant, asOf, quote, base, tenor, source);
  if (inverse) return { rate: inverse.all_in_rate, derivation: "INVERSE", quality: inverse.quality, source: inverse.source_code, loadId: inverse.load_id };
  return null;
}

const CURRENCY = /^[A-Z]{3}$/;
const TENOR = /^(SPOT|[1-9][0-9]{0,2}[DWMY])$/;

export function fxRateQuestions(db: Db): FxRateQuestions {
  return {
    async getRate(query): Promise<Rate | null> {
      const { tenantId: tenant, base, quote, asOf } = query;
      const tenor = query.tenor ?? "SPOT";
      if (!CURRENCY.test(base) || !CURRENCY.test(quote)) throw new RangeError("currencies must be three capital letters");
      if (!TENOR.test(tenor)) throw new RangeError("tenor must be SPOT or a code such as 1W, 1M, 3M");
      const common = { base, quote, tenor, asOf };

      if (base === quote) return { ...common, rate: fix(new Decimal(1)), derivation: "IDENTITY", quality: "VALID", source: null, loadIds: [] };

      const settings = await q(db).selectFrom("tenant_settings").select(["preferred_source", "pivot_currency"]).where("tenant_id", "=", tenant).executeTakeFirst();
      const source = query.source ?? settings?.preferred_source ?? null;
      const pivot = settings?.pivot_currency ?? "USD";

      const one = await leg(db, tenant, asOf, base, quote, tenor, source);
      if (one) {
        const rate = one.derivation === "INVERSE" ? invert(one.rate) : legRate(one);
        return { ...common, rate, derivation: one.derivation as Derivation, quality: one.quality, source: one.source, loadIds: [one.loadId] };
      }
      if (base === pivot || quote === pivot) return null;
      const first = await leg(db, tenant, asOf, base, pivot, tenor, source);
      const second = first && (await leg(db, tenant, asOf, pivot, quote, tenor, source));
      if (!first || !second) return null;
      return {
        ...common,
        rate: cross(first, second),
        derivation: "CROSS",
        quality: weakest([first.quality, second.quality]),
        source: [...new Set([first.source, second.source])].sort().join("+"),
        loadIds: [...new Set([first.loadId, second.loadId])],
      };
    },
  };
}
