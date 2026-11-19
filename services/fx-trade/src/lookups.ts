import { sql } from "kysely";
import type { AsOfDate, CycleId, ProgramId, TenantId } from "@shared/kernel";
import { asOfDate, programId as toProgramId } from "@shared/kernel";
import type { ExecutedTrade, FxTradeQuestions } from "../contract/index.ts";
import { q, type Db } from "./db.ts";
import { readPreTrades, toLeg } from "./store.ts";

const arr = <T>(v: T[] | string): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : v);
const obj = (v: Record<string, string> | string): Record<string, string> => (typeof v === "string" ? JSON.parse(v) : v);

export function fxTradeQuestions(db: Db): FxTradeQuestions {
  async function executed(tenant: TenantId, where: (s: ReturnType<typeof base>) => ReturnType<typeof base>): Promise<ExecutedTrade[]> {
    const heads = await where(base(tenant)).orderBy("trade_date").orderBy("platform").orderBy("trade_id").execute();
    if (heads.length === 0) return [];
    const legs = await q(db).selectFrom("executed_trade_legs").selectAll().where("tenant_id", "=", tenant).where("executed_trade_id", "in", heads.map((h) => h.executed_trade_id)).orderBy("leg_no").execute();
    return heads.map((h) => ({
      executedTradeId: h.executed_trade_id, platform: h.platform, tradeId: h.trade_id, version: h.version, cancelled: h.cancelled,
      programId: h.program_id === null ? null : toProgramId(h.program_id), tradingEntityCode: h.trading_entity_code, counterparty: h.counterparty, tradeDate: asOfDate(h.trade_date),
      instrument: h.instrument, portfolio: h.portfolio, legs: legs.filter((l) => l.executed_trade_id === h.executed_trade_id).map((l) => toLeg(l) as ExecutedTrade["legs"][number]),
      customFields: obj(h.custom_fields), matchStatus: h.match_status, preTradeId: h.pre_trade_id, matchNote: h.match_note, candidates: arr<string>(h.candidates), batchId: h.batch_id,
    }));
  }
  const base = (tenant: TenantId) => q(db).selectFrom("executed_trades").selectAll().where("tenant_id", "=", tenant).where("is_current", "=", true);

  return {
    preTrades: (tenant, filter = {}) => readPreTrades(db, tenant, filter),
    async getPreTrade(tenant, id) {
      return (await readPreTrades(db, tenant, { ids: [id] }))[0] ?? null;
    },
    async executedTrades(tenant, query: { programId: ProgramId; asOf: AsOfDate }) {
      const open = await q(db).selectFrom("executed_trade_legs as l").select("l.executed_trade_id").where("l.tenant_id", "=", tenant).groupBy("l.executed_trade_id")
        .having(sql<string>`max(l.value_date)`, ">", query.asOf).execute();
      if (open.length === 0) return [];
      const ids = open.map((o) => o.executed_trade_id);
      return executed(tenant, (s) => s.where("program_id", "=", query.programId).where("cancelled", "=", false).where("trade_date", "<=", query.asOf).where("executed_trade_id", "in", ids));
    },
    unmatchedTrades(tenant, filter = {}) {
      return executed(tenant, (s) => {
        let r = s.where("match_status", "<>", "MATCHED").where("cancelled", "=", false);
        if (filter.programId) r = r.where("program_id", "=", filter.programId);
        return r;
      });
    },
    async tradeIssues(tenant, batchId) {
      let s = q(db).selectFrom("trade_issues").select(["batch_id", "row_no", "code", "message"]).where("tenant_id", "=", tenant);
      if (batchId) s = s.where("batch_id", "=", batchId);
      return (await s.orderBy("created_at").orderBy("row_no").execute()).map((r) => ({ batchId: r.batch_id, rowNo: r.row_no, code: r.code, message: r.message }));
    },
  };
}
export type { CycleId };
