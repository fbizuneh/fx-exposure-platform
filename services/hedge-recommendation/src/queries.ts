// Reads: the policy with defaults filled in, and the cycle's recommendations.
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";
import type { FollowUp, HedgePolicy, HedgeRecommendationQuestions, NoActionReason, Recommendation, RecommendationStatus, Strategy } from "../contract/index.ts";
import type { Selectable } from "kysely";
import { q, type Db, type Queryable } from "./db.ts";
import type { HedgeRecommendationDatabase } from "./schema.ts";

/** A numeric(…,4) column as a decimal string without trailing zeros beyond two places: "100.5000" is "100.50". */
const amount = (v: string): string => (/\.\d{2}00$/.test(v) ? v.slice(0, -2) : v);
const opt = (v: string | null): string | null => (v === null ? null : amount(v));
/** A ratio column (6 places) as a plain decimal: "1.000000" is "1", "0.800000" is "0.8". */
const ratio = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

export const DEFAULTS = { defaultRatio: "1", minHedgeDisplay: "0", roundingDefault: "1000", tenor: "1M" } as const;

export async function readPolicy(db: Queryable, tenant: TenantId, program: ProgramId): Promise<HedgePolicy> {
  const row = await q(db).selectFrom("policies").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).executeTakeFirst();
  const ratios = await q(db).selectFrom("ratio_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("currency_pair").execute();
  const roundings = await q(db).selectFrom("rounding_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("currency").execute();
  return {
    programId: program,
    defaultRatio: row ? ratio(row.default_ratio) : DEFAULTS.defaultRatio,
    ratioOverrides: ratios.map((r) => ({ pair: r.currency_pair, ratio: ratio(r.ratio) })),
    minHedgeDisplay: row ? amount(row.min_hedge_display) : DEFAULTS.minHedgeDisplay,
    roundingDefault: row ? amount(row.rounding_default) : DEFAULTS.roundingDefault,
    roundingOverrides: roundings.map((r) => ({ currency: r.currency, rounding: amount(r.rounding) })),
    tenor: row ? row.tenor : DEFAULTS.tenor,
    tradingEntityCode: row ? row.trading_entity_code : null,
    saved: row !== undefined,
  };
}

type Row = Selectable<HedgeRecommendationDatabase["recommendations"]>;
export const toRecommendation = (r: Row): Recommendation => ({
  recommendationId: r.recommendation_id, programId: r.program_id as ProgramId, cycleId: r.cycle_id as CycleId, runId: r.run_id, strategy: r.strategy as Strategy,
  groupNo: r.group_no, nettingLevel: r.netting_level, region: r.region, entityCode: r.entity_code, currencyPair: r.currency_pair, exposureCurrency: r.exposure_currency,
  otherCurrency: r.other_currency, tradingEntityCode: r.trading_entity_code, grossExposure: amount(r.gross_exposure), hedgedAmount: amount(r.hedged_amount), ratio: ratio(r.ratio), targetHedge: amount(r.target_hedge),
  neededAmount: amount(r.needed_amount), rounding: amount(r.rounding), minExposureAmount: opt(r.min_exposure_amount), action: r.action as Recommendation["action"],
  reason: r.reason as NoActionReason | null, direction: r.direction as Recommendation["direction"], amount: opt(r.amount), instrument: r.instrument as Recommendation["instrument"],
  valueDate: r.value_date, fixingDate: r.fixing_date, status: r.status as RecommendationStatus, decidedAmount: opt(r.decided_amount), decidedBy: r.decided_by,
  decidedAt: r.decided_at === null ? null : r.decided_at.toISOString(), decisionNote: r.decision_note, preTradeId: r.pre_trade_id, followUp: r.follow_up as FollowUp,
});

export function hedgeRecommendationQuestions(db: Db): HedgeRecommendationQuestions {
  return {
    policy: (tenant, program) => readPolicy(db, tenant, program),
    async recommendations(tenant, cycle) {
      const rows = await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).where("status", "<>", "SUPERSEDED")
        .orderBy("action", "asc").orderBy("group_no").execute();
      return rows.map(toRecommendation);
    },
    async getRecommendation(tenant, id) {
      const r = await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).executeTakeFirst();
      return r ? toRecommendation(r) : null;
    },
  };
}
