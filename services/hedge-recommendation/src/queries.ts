// Reads: the policy with defaults filled in, and the cycle's recommendations.
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";
import type { CalendarGap, FollowUp, HedgePolicy, HedgeRecommendationQuestions, NoActionReason, Recommendation, RecommendationPart, RecommendationStatus, SplitMethod, Strategy } from "../contract/index.ts";
import type { Selectable } from "kysely";
import { q, type Db, type Queryable } from "./db.ts";
import type { HedgeRecommendationDatabase } from "./schema.ts";

/** A numeric(…,4) column as a decimal string without trailing zeros beyond two places: "100.5000" is "100.50". */
const amount = (v: string): string => (/\.\d{2}00$/.test(v) ? v.slice(0, -2) : v);
const opt = (v: string | null): string | null => (v === null ? null : amount(v));
/** A ratio column (6 places) as a plain decimal: "1.000000" is "1", "0.800000" is "0.8". */
const ratio = (v: string): string => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);

export const DEFAULTS = { defaultRatio: "1", minHedgeDisplay: "0", roundingDefault: "1000", tenor: "1M", splitMethod: "EVEN", strategy: "hedge-ratio-adjustment" } as const;

/**
 * The policy with its overrides, read from one snapshot. A save replaces the policy and its overrides in one transaction, so separate statements that each took
 * their own snapshot could return the old policy with the new overrides (decision 0020). Given a transaction, its own snapshot is used.
 */
export async function readPolicy(db: Queryable, tenant: TenantId, program: ProgramId): Promise<HedgePolicy> {
  if (db.isTransaction) return readPolicyRows(db, tenant, program);
  return db.transaction().setIsolationLevel("repeatable read").execute((tx) => readPolicyRows(tx, tenant, program));
}

async function readPolicyRows(db: Queryable, tenant: TenantId, program: ProgramId): Promise<HedgePolicy> {
  const row = await q(db).selectFrom("policies").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).executeTakeFirst();
  const ratios = await q(db).selectFrom("ratio_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("currency_pair").execute();
  const roundings = await q(db).selectFrom("rounding_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("currency").execute();
  const thresholds = await q(db).selectFrom("amount_threshold_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("netting_level").execute();
  const maxes = await q(db).selectFrom("max_hedge_overrides").selectAll().where("tenant_id", "=", tenant).where("program_id", "=", program).orderBy("netting_level").execute();
  return {
    programId: program,
    defaultRatio: row ? ratio(row.default_ratio) : DEFAULTS.defaultRatio,
    ratioOverrides: ratios.map((r) => ({ pair: r.currency_pair, ratio: ratio(r.ratio) })),
    minHedgeDisplay: row ? amount(row.min_hedge_display) : DEFAULTS.minHedgeDisplay,
    roundingDefault: row ? amount(row.rounding_default) : DEFAULTS.roundingDefault,
    roundingOverrides: roundings.map((r) => ({ currency: r.currency, rounding: amount(r.rounding) })),
    tenor: row ? row.tenor : DEFAULTS.tenor,
    tradingEntityCode: row ? row.trading_entity_code : null,
    maxHedgeDisplay: row ? opt(row.max_hedge_display) : null,
    maxHedgeOverrides: maxes.map((m) => ({ nettingLevel: m.netting_level, maxHedgeDisplay: amount(m.max_hedge_display) })),
    splitMethod: row ? (row.split_method as SplitMethod) : DEFAULTS.splitMethod,
    strategy: row ? (row.strategy as Strategy) : DEFAULTS.strategy,
    amountThresholdDisplay: row ? opt(row.amount_threshold_display) : null,
    amountThresholdOverrides: thresholds.map((m) => ({ nettingLevel: m.netting_level, amountThresholdDisplay: amount(m.amount_threshold_display) })),
    saved: row !== undefined,
  };
}

type Row = Selectable<HedgeRecommendationDatabase["recommendations"]>;
export const toRecommendation = (r: Row, parts: readonly Selectable<HedgeRecommendationDatabase["recommendation_parts"]>[] = []): Recommendation => ({
  recommendationId: r.recommendation_id, programId: r.program_id as ProgramId, cycleId: r.cycle_id as CycleId, runId: r.run_id, strategy: r.strategy as Strategy,
  groupNo: r.group_no, nettingLevel: r.netting_level, region: r.region, entityCode: r.entity_code, currencyPair: r.currency_pair, exposureCurrency: r.exposure_currency,
  otherCurrency: r.other_currency, tradingEntityCode: r.trading_entity_code, grossExposure: amount(r.gross_exposure), hedgedAmount: amount(r.hedged_amount), ratio: r.ratio === null ? null : ratio(r.ratio), thresholdExposureAmount: opt(r.threshold_exposure_amount), targetHedge: amount(r.target_hedge),
  neededAmount: amount(r.needed_amount), rounding: amount(r.rounding), minExposureAmount: opt(r.min_exposure_amount), action: r.action as Recommendation["action"],
  reason: r.reason as NoActionReason | null, direction: r.direction as Recommendation["direction"], amount: opt(r.amount), instrument: r.instrument as Recommendation["instrument"],
  valueDate: r.value_date, fixingDate: r.fixing_date, calendarGaps: (typeof r.calendar_gaps === "string" ? JSON.parse(r.calendar_gaps) : r.calendar_gaps) as CalendarGap[], status: r.status as RecommendationStatus, decidedAmount: opt(r.decided_amount), decidedBy: r.decided_by,
  decidedAt: r.decided_at === null ? null : r.decided_at.toISOString(), decisionNote: r.decision_note, preTradeId: parts[0]?.pre_trade_id ?? null, followUp: r.follow_up as FollowUp,
  maxExposureAmount: opt(r.max_exposure_amount), splitMethod: r.split_method as SplitMethod | null, splitNote: r.split_note,
  parts: parts.map((x): RecommendationPart => ({ partNo: x.part_no, amount: amount(x.amount), preTradeId: x.pre_trade_id, followUp: x.follow_up as FollowUp })),
});

/** The recommendations with their parts, read together. */
export async function withParts(db: Queryable, tenant: TenantId, rows: readonly Row[]): Promise<Recommendation[]> {
  if (rows.length === 0) return [];
  const parts = await q(db).selectFrom("recommendation_parts").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "in", rows.map((r) => r.recommendation_id)).orderBy("part_no").execute();
  return rows.map((r) => toRecommendation(r, parts.filter((x) => x.recommendation_id === r.recommendation_id)));
}

export function hedgeRecommendationQuestions(db: Db): HedgeRecommendationQuestions {
  return {
    policy: (tenant, program) => readPolicy(db, tenant, program),
    async recommendations(tenant, cycle) {
      const rows = await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).where("status", "<>", "SUPERSEDED")
        .orderBy("action", "asc").orderBy("group_no").execute();
      return withParts(db, tenant, rows);
    },
    async deciders(tenant, cycle) {
      const rows = await q(db).selectFrom("recommendations").select("decided_by").distinct().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle)
        .where("status", "in", ["ACCEPTED", "OVERRIDDEN", "DECIDING"]).where("decided_by", "is not", null).orderBy("decided_by").execute();
      return rows.map((r) => r.decided_by!);
    },
    async approvalHolds(tenant, cycle) {
      const rows = await q(db).selectFrom("approval_holds").select("approver").distinct().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).orderBy("approver").execute();
      return rows.map((r) => r.approver);
    },
    async getRecommendation(tenant, id) {
      const r = await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).executeTakeFirst();
      return r ? (await withParts(db, tenant, [r]))[0]! : null;
    },
  };
}
