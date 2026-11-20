// The one write path: a load of rates from one source for one business date, applied in one transaction with its event.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AsOfDate, TenantId } from "@shared/kernel";
import { q, type Db } from "./db.ts";
import { byPerson, recordChange } from "./change-record.ts";
import { announce } from "./outbox.ts";
import type { RateRow } from "./rows.ts";
import { DEFAULT_OUTLIER_SHARE, qualityOf, RatesInvalid, rowKey, validateRates } from "./validate.ts";

export interface RateLoad {
  readonly tenantId: TenantId;
  readonly source: string;
  readonly businessDate: AsOfDate;
  readonly rows: readonly RateRow[];
  /** Who or what sent it: a user id or a connector name. */
  readonly by: string;
}

export interface LoadResult {
  readonly status: "APPLIED" | "DUPLICATE";
  readonly loadId: string;
  readonly accepted: number;
  /** Rates stored as stale or outlier. They are kept, and lookups show their quality. */
  readonly flagged: number;
}

const SOURCE = /^[A-Za-z0-9._-]{1,64}$/;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function loadCommands(db: Db, clock: () => Date) {
  async function loadRates(load: RateLoad): Promise<LoadResult> {
    if (!SOURCE.test(load.source)) throw new RatesInvalid([`source "${load.source}" must be letters, digits, dot, dash or underscore`]);
    const now = clock();
    const problems = validateRates(load.rows, load.businessDate, now);
    if (problems.length > 0) throw new RatesInvalid(problems);
    const hash = createHash("sha256").update(stable([...load.rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1)))).digest("hex");
    const tenant = load.tenantId;

    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant}:${load.source}`}))`.execute(tx);

      const dup = await q(tx).selectFrom("rate_loads").select("load_id")
        .where("tenant_id", "=", tenant).where("source_code", "=", load.source).where("business_date", "=", load.businessDate).where("content_hash", "=", hash)
        .executeTakeFirst();
      if (dup) return { status: "DUPLICATE", loadId: dup.load_id, accepted: 0, flagged: 0 } as const;

      await q(tx).insertInto("rate_sources").values({ tenant_id: tenant, source_code: load.source, stale_after_minutes: null }).onConflict((oc) => oc.doNothing()).execute();
      const source = await q(tx).selectFrom("rate_sources").select("stale_after_minutes").where("tenant_id", "=", tenant).where("source_code", "=", load.source).executeTakeFirstOrThrow();
      const settings = await q(tx).selectFrom("tenant_settings").select("outlier_share").where("tenant_id", "=", tenant).executeTakeFirst();
      const outlierShare = settings ? Number(settings.outlier_share) : DEFAULT_OUTLIER_SHARE;
      const endOfDate = new Date(new Date(`${load.businessDate}T00:00:00Z`).getTime() + 86_400_000);

      const loadId = randomUUID();
      const values = [];
      let flagged = 0;
      for (const r of load.rows) {
        const prior = await q(tx).selectFrom("rates").select("all_in_rate")
          .where("tenant_id", "=", tenant).where("source_code", "=", load.source).where("base_currency", "=", r.base).where("quote_currency", "=", r.quote)
          .where("tenor", "=", r.tenor).where("business_date", "<", load.businessDate).where("quality", "=", "VALID")
          .orderBy("business_date", "desc").orderBy("loaded_at", "desc").limit(1).executeTakeFirst();
        const quality = qualityOf(new Date(r.observedAt), endOfDate, source.stale_after_minutes, r.allIn, prior?.all_in_rate ?? null, outlierShare);
        if (quality !== "VALID") flagged++;
        values.push({
          tenant_id: tenant, rate_id: randomUUID(), load_id: loadId, source_code: load.source, business_date: load.businessDate,
          base_currency: r.base, quote_currency: r.quote, rate_type: r.type, tenor: r.tenor, value_date: r.valueDate,
          all_in_rate: r.allIn, spot_rate: r.spot, forward_points: r.forwardPoints, bid: r.bid, mid: r.mid, ask: r.ask,
          observed_at: new Date(r.observedAt), quality,
        });
      }
      await q(tx).insertInto("rate_loads").values({
        tenant_id: tenant, load_id: loadId, source_code: load.source, business_date: load.businessDate, content_hash: hash,
        row_count: values.length, warning_count: flagged, created_by: load.by,
      }).execute();
      await q(tx).insertInto("rates").values(values).execute();
      await announce(tx, { type: "fx-rate.loaded", tenantId: tenant, loadId, source: load.source, businessDate: load.businessDate });
      if (byPerson(load.by)) await recordChange(tx, { tenantId: tenant, programId: null, actor: load.by, action: "fx-rates.loaded", targetType: "rate-load", targetId: loadId, fields: [] });
      return { status: "APPLIED", loadId, accepted: values.length, flagged } as const;
    });
  }

  const upsertSettings = (tenant: TenantId, set: Record<string, unknown>) =>
    q(db).insertInto("tenant_settings").values({ tenant_id: tenant, ...set })
      .onConflict((oc) => oc.column("tenant_id").doUpdateSet({ ...set, updated_at: new Date() })).execute();

  return {
    loadRates,

    /** Minutes after which a source's observation counts as stale. Null means never. Applies to later loads. */
    async setStaleAfter(tenant: TenantId, source: string, minutes: number | null): Promise<void> {
      if (!SOURCE.test(source)) throw new RangeError("invalid source code");
      if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0)) throw new RangeError("minutes must be a positive whole number");
      await q(db).insertInto("rate_sources").values({ tenant_id: tenant, source_code: source, stale_after_minutes: minutes })
        .onConflict((oc) => oc.columns(["tenant_id", "source_code"]).doUpdateSet({ stale_after_minutes: minutes })).execute();
    },

    /** The source lookups use unless a query names another. Null means any source, latest load first. */
    async setPreferredSource(tenant: TenantId, source: string | null): Promise<void> {
      if (source !== null && !SOURCE.test(source)) throw new RangeError("invalid source code");
      await upsertSettings(tenant, { preferred_source: source });
    },

    async setPivotCurrency(tenant: TenantId, currency: string): Promise<void> {
      if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError("currency must be three capital letters");
      await upsertSettings(tenant, { pivot_currency: currency });
    },

    /** The change from the prior valid rate that raises an outlier flag, as a share: 0.1 is 10%. */
    async setOutlierShare(tenant: TenantId, share: number): Promise<void> {
      if (!(share > 0 && share <= 1)) throw new RangeError("share must be above 0 and at most 1");
      await upsertSettings(tenant, { outlier_share: share.toFixed(3) });
    },
  };
}
