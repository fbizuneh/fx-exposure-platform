// Reads and the status rule shared by the commands and the questions.
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";
import type { PreTrade, PreTradeStatus, TradeLeg } from "../contract/index.ts";
import { q, type Queryable } from "./db.ts";
import { fixed4, fromUnits, units, type OpenPreTrade } from "./model.ts";

type LegRow = { leg_no: number; leg_role: "SINGLE" | "NEAR" | "FAR"; direction: "BUY" | "SELL"; deal_currency: string; deal_amount: string; settlement_currency: string; settlement_amount: string | null; value_date: string; fixing_date: string | null };
export const toLeg = (l: LegRow): TradeLeg => ({
  legNo: l.leg_no, role: l.leg_role, direction: l.direction, dealCurrency: l.deal_currency, dealAmount: fixed4(l.deal_amount),
  settlementCurrency: l.settlement_currency, settlementAmount: l.settlement_amount === null ? null : fixed4(l.settlement_amount), valueDate: l.value_date, fixingDate: l.fixing_date,
});

/** Deal amount filled so far on each pre-trade: current, live, matched executed trades (first leg; a swap's legs share one amount). */
export async function filledAmounts(db: Queryable, tenant: TenantId, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await q(db)
    .selectFrom("executed_trades as e")
    .innerJoin("executed_trade_legs as l", (j) => j.onRef("l.tenant_id", "=", "e.tenant_id").onRef("l.executed_trade_id", "=", "e.executed_trade_id"))
    .select(["e.pre_trade_id as pre_trade_id", (eb) => eb.fn.sum<string>("l.deal_amount").as("filled")])
    .where("e.tenant_id", "=", tenant).where("e.is_current", "=", true).where("e.cancelled", "=", false).where("l.leg_no", "=", 1)
    .where("e.pre_trade_id", "in", [...ids]).groupBy("e.pre_trade_id").execute();
  return new Map(rows.map((r) => [r.pre_trade_id!, fixed4(String(r.filled))]));
}

export async function readPreTrades(
  db: Queryable, tenant: TenantId, filter: { cycleId?: CycleId; programId?: ProgramId; status?: PreTradeStatus; ids?: readonly string[]; recommendationIds?: readonly string[] } = {},
): Promise<PreTrade[]> {
  if (filter.ids?.length === 0 || filter.recommendationIds?.length === 0) return [];
  let sel = q(db).selectFrom("pre_trades").selectAll().where("tenant_id", "=", tenant);
  if (filter.cycleId) sel = sel.where("cycle_id", "=", filter.cycleId);
  if (filter.programId) sel = sel.where("program_id", "=", filter.programId);
  if (filter.status) sel = sel.where("status", "=", filter.status);
  if (filter.ids) sel = sel.where("pre_trade_id", "in", [...filter.ids]);
  if (filter.recommendationIds) sel = sel.where("recommendation_id", "in", [...filter.recommendationIds]);
  const heads = await sel.orderBy("created_at").orderBy("part_no").orderBy("reference").execute();
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.pre_trade_id);
  const legs = await q(db).selectFrom("pre_trade_legs").selectAll().where("tenant_id", "=", tenant).where("pre_trade_id", "in", ids).orderBy("leg_no").execute();
  const filled = await filledAmounts(db, tenant, ids);
  return heads.map((h) => ({
    preTradeId: h.pre_trade_id, reference: h.reference, programId: h.program_id as ProgramId, cycleId: h.cycle_id as CycleId | null, recommendationId: h.recommendation_id, partNo: h.part_no,
    origin: h.origin, status: h.status, tradingEntityCode: h.trading_entity_code, instrument: h.instrument,
    legs: legs.filter((l) => l.pre_trade_id === h.pre_trade_id).map(toLeg), filledAmount: filled.get(h.pre_trade_id) ?? "0.0000",
  }));
}

/** Sent or ready pre-trades of a program and entity with room left, for matching. */
export async function openPreTrades(db: Queryable, tenant: TenantId, program: string, reference?: string): Promise<OpenPreTrade[]> {
  let sel = q(db).selectFrom("pre_trades").select("pre_trade_id").where("tenant_id", "=", tenant).where("program_id", "=", program).where("status", "in", ["READY", "SENT", "PARTLY_EXECUTED"]);
  if (reference) sel = sel.where("reference", "=", reference);
  const ids = (await sel.execute()).map((r) => r.pre_trade_id);
  return (await readPreTrades(db, tenant, { ids })).map((p) => {
    const total = units(p.legs[0]!.dealAmount);
    const filled = units(p.filledAmount);
    const remaining = p.instrument === "SWAP" ? (filled > 0n ? 0n : total) : total - filled;
    return {
      preTradeId: p.preTradeId, reference: p.reference, programId: p.programId, tradingEntityCode: p.tradingEntityCode, instrument: p.instrument,
      legs: p.legs.map((l) => ({ role: l.role, direction: l.direction, dealCurrency: l.dealCurrency, dealAmount: l.dealAmount, settlementCurrency: l.settlementCurrency, settlementAmount: l.settlementAmount, valueDate: l.valueDate, fixingDate: l.fixingDate })),
      remaining: fromUnits(remaining < 0n ? 0n : remaining),
    };
  });
}

/** READY, SENT, PARTLY_EXECUTED and EXECUTED follow from the fills; DRAFT and CANCELLED are left alone. */
export async function recomputeStatus(tx: Queryable, tenant: TenantId, preTradeId: string): Promise<void> {
  const row = await q(tx).selectFrom("pre_trades").select(["status", "sent_at"]).where("tenant_id", "=", tenant).where("pre_trade_id", "=", preTradeId).forUpdate().executeTakeFirst();
  if (!row || row.status === "DRAFT" || row.status === "CANCELLED") return;
  const [p] = await readPreTrades(tx, tenant, { ids: [preTradeId] });
  if (!p) return;
  const filled = units(p.filledAmount);
  const total = units(p.legs[0]!.dealAmount);
  const status: PreTradeStatus = filled >= total ? "EXECUTED" : filled > 0n ? "PARTLY_EXECUTED" : row.sent_at ? "SENT" : "READY";
  if (status !== row.status) await q(tx).updateTable("pre_trades").set({ status }).where("tenant_id", "=", tenant).where("pre_trade_id", "=", preTradeId).execute();
}
