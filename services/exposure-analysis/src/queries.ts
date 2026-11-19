// The questions Exposure Analysis answers. Amounts are exact decimal strings.
import { asOfDate, cycleId, lineageRef, programId, type CycleId, type TenantId } from "@shared/kernel";
import type { BaselineRow, ExposureAnalysisQuestions, ExposureGroup, FilterCounts, HedgeCounts, HedgeRow, NetExposureGroup, RateUsed, RateWarning, RunSummary } from "../contract/index.ts";
import { q, type Db } from "./db.ts";

const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
/** A numeric(…,4) column as a decimal string without trailing zeros beyond two places: "100.5000" is "100.50". */
const amount = (v: string): string => (/\.\d{2}00$/.test(v) ? v.slice(0, -2) : v);

export function exposureAnalysisQuestions(db: Db): ExposureAnalysisQuestions {
  return {
    async currentRun(tenant: TenantId, cycle: CycleId): Promise<RunSummary | null> {
      const r = await q(db).selectFrom("runs").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).where("status", "<>", "SUPERSEDED").executeTakeFirst();
      if (!r) return null;
      return {
        runId: r.run_id, cycleId: cycleId(r.cycle_id), programId: programId(r.program_id), asOf: asOfDate(r.as_of), status: r.status, waitReason: r.wait_reason,
        nettingLevel: r.netting_level as RunSummary["nettingLevel"], displayCurrency: r.display_currency,
        counts: r.counts === null ? null : json<FilterCounts>(r.counts), hedgeCounts: r.hedge_counts === null ? null : json<HedgeCounts>(r.hedge_counts), blockedBalances: r.blocked_count, warnings: r.warnings === null ? [] : json<RateWarning[]>(r.warnings),
        attemptedAt: r.attempted_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, frozenAt: r.frozen_at?.toISOString() ?? null,
      };
    },

    async exposures(tenant: TenantId, runId: string): Promise<readonly ExposureGroup[]> {
      const rows = await q(db).selectFrom("exposure_groups").selectAll().where("tenant_id", "=", tenant).where("run_id", "=", runId).orderBy("group_no").execute();
      return rows.map((g) => ({
        groupNo: g.group_no, nettingLevel: g.netting_level as ExposureGroup["nettingLevel"], region: g.region, entityCode: g.entity_code, currencyPair: g.currency_pair,
        currency1: g.currency1, currency2: g.currency2, exposureCurrency: g.exposure_currency, period: asOfDate(g.period), rowCount: g.row_count,
        long1: amount(g.long1), short1: amount(g.short1), net1: amount(g.net1), net2: amount(g.net2), exposureAmount: amount(g.exposure_amount),
        displayCurrency: g.display_currency, displayRate: g.display_rate, displayAmount: amount(g.display_amount),
      }));
    },

    async drilldown(tenant: TenantId, runId: string, groupNo: number): Promise<readonly BaselineRow[]> {
      const rows = await q(db).selectFrom("group_members as m")
        .innerJoin("baseline_rows as b", (j) => j.onRef("b.tenant_id", "=", "m.tenant_id").onRef("b.run_id", "=", "m.run_id").onRef("b.row_no", "=", "m.row_no"))
        .select(["b.row_no", "b.source_system", "b.batch_id", "b.record_id", "b.entity_code", "b.region", "b.chart_code", "b.account_number", "b.period", "b.transaction_currency",
          "b.functional_currency", "b.currency_pair", "b.pair_rate", "b.amount", "b.amount1", "b.amount2", "b.dimensions", "m.amount1 as c1", "m.amount2 as c2"])
        .where("m.tenant_id", "=", tenant).where("m.run_id", "=", runId).where("m.group_no", "=", groupNo).orderBy("b.row_no").orderBy("m.amount1").execute();
      return rows.map((b) => ({
        rowNo: b.row_no, lineage: lineageRef(b.source_system, b.batch_id, b.record_id), entityCode: b.entity_code, region: b.region, chartCode: b.chart_code, accountNumber: b.account_number,
        period: asOfDate(b.period), transactionCurrency: b.transaction_currency, functionalCurrency: b.functional_currency, currencyPair: b.currency_pair, pairRate: b.pair_rate,
        amount: amount(b.amount), amount1: amount(b.amount1), amount2: amount(b.amount2), dimensions: json<Record<string, string>>(b.dimensions),
        contribution: { amount1: amount(b.c1), amount2: amount(b.c2) },
      }));
    },

    async netExposures(tenant: TenantId, runId: string): Promise<readonly NetExposureGroup[]> {
      const rows = await q(db).selectFrom("net_groups").selectAll().where("tenant_id", "=", tenant).where("run_id", "=", runId).orderBy("group_no").execute();
      return rows.map((g) => ({
        groupNo: g.group_no, nettingLevel: g.netting_level as NetExposureGroup["nettingLevel"], region: g.region, entityCode: g.entity_code, currencyPair: g.currency_pair,
        currency1: g.currency1, currency2: g.currency2, exposureCurrency: g.exposure_currency, period: asOfDate(g.period), displayCurrency: g.display_currency, displayRate: g.display_rate,
        gross: { net1: amount(g.gross_net1), net2: amount(g.gross_net2), exposureAmount: amount(g.gross_exposure), displayAmount: amount(g.gross_display) },
        hedges: { net1: amount(g.hedge_net1), net2: amount(g.hedge_net2), exposureAmount: amount(g.hedge_exposure), displayAmount: amount(g.hedge_display) },
        net: { net1: amount(g.net_net1), net2: amount(g.net_net2), exposureAmount: amount(g.net_exposure), displayAmount: amount(g.net_display) },
      }));
    },

    async hedgeRows(tenant: TenantId, runId: string): Promise<readonly HedgeRow[]> {
      const rows = await q(db).selectFrom("hedge_rows").selectAll().where("tenant_id", "=", tenant).where("run_id", "=", runId).orderBy("row_no").execute();
      return rows.map((h) => ({
        rowNo: h.row_no, executedTradeId: h.executed_trade_id, platform: h.platform, tradeId: h.trade_id, legNo: h.leg_no, entityCode: h.entity_code, region: h.region, period: asOfDate(h.period),
        dealCurrency: h.deal_currency, settlementCurrency: h.settlement_currency, currencyPair: h.currency_pair, amount1: amount(h.amount1), amount2: amount(h.amount2),
      }));
    },

    async ratesUsed(tenant: TenantId, runId: string): Promise<readonly RateUsed[]> {
      const rows = await q(db).selectFrom("rates_used").selectAll().where("tenant_id", "=", tenant).where("run_id", "=", runId).orderBy("base").orderBy("quote").orderBy("purpose").execute();
      return rows.map((r) => ({
        base: r.base, quote: r.quote, purpose: r.purpose, rate: r.rate, quality: r.quality as RateUsed["quality"], derivation: r.derivation, source: r.source, loadIds: json<string[]>(r.load_ids),
      }));
    },
  };
}
