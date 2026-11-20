// Executed trades in: validate, version, match to pre-trades, store, announce. Nothing is dropped.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { ProgramId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { asOfDate, programId as toProgramId } from "@shared/kernel";
import type { Instrument } from "../contract/index.ts";
import { INSTRUMENTS } from "../contract/index.ts";
import { q, type Db, type Tx } from "./db.ts";
import type { ExecutedRow } from "./file.ts";
import { AccessDenied, require_, who } from "./access.ts";
import { fixed4, legProblems, matchTrade, misfit, realDate, type LegInput } from "./model.ts";
import { recordChange } from "./change-record.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { openPreTrades, recomputeStatus } from "./store.ts";

export interface ImportResult {
  readonly status: "APPLIED" | "DUPLICATE";
  readonly batchId: string;
  readonly received: number;
  /** New trades and new versions. */
  readonly stored: number;
  readonly unchanged: number;
  readonly blocked: number;
  readonly matched: number;
  readonly unmatched: number;
}

interface Issue { rowNo: number; code: string; message: string; raw: ExecutedRow }
interface Trade {
  key: string;
  platform: string;
  tradeId: string;
  programId: string | null;
  tradingEntityCode: string;
  counterparty: string | null;
  tradeDate: string;
  instrument: Instrument;
  portfolio: string | null;
  preTradeReference: string | null;
  custom: Record<string, string>;
  legs: LegInput[];
  rows: ExecutedRow[];
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha = (v: unknown): string => createHash("sha256").update(stable(v)).digest("hex");

const MISSING_HEADER: Array<[keyof ExecutedRow, string]> = [
  ["tradeId", "trade ID"], ["platform", "execution platform ID"], ["tradingEntity", "trading entity"], ["tradeDate", "trade date"], ["instrument", "instrument"],
  ["buySell", "buy or sell"], ["dealCurrency", "deal currency"], ["dealAmount", "deal amount"], ["settlementCurrency", "settlement currency"], ["settlementAmount", "settlement amount"], ["valueDate", "value date"],
];

/** Rows to trades. A trade with any problem is blocked whole: its rows become issues and nothing of it is stored. */
function assemble(rows: readonly ExecutedRow[]): { trades: Trade[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const groups = new Map<string, ExecutedRow[]>();
  for (const r of rows) {
    const missing = MISSING_HEADER.filter(([k]) => r[k] === null).map(([, n]) => n);
    if (missing.length > 0) { issues.push({ rowNo: r.rowNo, code: "MISSING", message: `missing ${missing.join(", ")}`, raw: r }); continue; }
    const k = `${r.platform}|${r.tradeId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const trades: Trade[] = [];
  for (const [key, rs] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = rs[0]!;
    const block = (code: string, message: string) => rs.forEach((r) => issues.push({ rowNo: r.rowNo, code, message, raw: r }));
    const instrument = (first.instrument ?? "").toUpperCase() as Instrument;
    if (!INSTRUMENTS.includes(instrument)) { block("INSTRUMENT", `instrument "${first.instrument}" is not one of ${INSTRUMENTS.join(", ")}`); continue; }
    const same = (f: (r: ExecutedRow) => string | null) => rs.every((r) => f(r) === f(first));
    if (!same((r) => r.tradingEntity) || !same((r) => r.tradeDate) || !same((r) => (r.instrument ?? "").toUpperCase()) || !same((r) => r.programId) || !same((r) => r.counterparty) || !same((r) => r.preTradeReference)) {
      block("INCONSISTENT", "rows of one trade disagree on entity, trade date, instrument, program, counterparty or pre-trade reference"); continue;
    }
    if (!realDate(first.tradeDate!)) { block("DATE", `trade date "${first.tradeDate}" is not a date`); continue; }
    if (instrument === "SWAP" ? rs.length !== 2 || rs.map((r) => r.leg).sort().join(",") !== "FAR,NEAR" : rs.length !== 1 || (rs[0]!.leg !== null && rs[0]!.leg !== "SINGLE")) {
      block("LEGS", instrument === "SWAP" ? "a swap arrives as one NEAR row and one FAR row with the same trade ID" : "a trade with this ID appears more than once in the file"); continue;
    }
    const ordered = instrument === "SWAP" ? [...rs].sort((a, b) => (a.leg === "NEAR" ? -1 : b.leg === "NEAR" ? 1 : 0)) : rs;
    const legs: LegInput[] = ordered.map((r) => ({
      role: instrument === "SWAP" ? (r.leg as "NEAR" | "FAR") : "SINGLE", direction: (r.buySell ?? "").toUpperCase() as "BUY" | "SELL", dealCurrency: (r.dealCurrency ?? "").toUpperCase(),
      dealAmount: r.dealAmount!, settlementCurrency: (r.settlementCurrency ?? "").toUpperCase(), settlementAmount: r.settlementAmount, valueDate: r.valueDate!, fixingDate: r.fixingDate,
    }));
    const problems = legProblems(instrument, legs, true);
    if (problems.length > 0) { block("INVALID", problems.join("; ")); continue; }
    trades.push({
      key, platform: first.platform!, tradeId: first.tradeId!, programId: first.programId, tradingEntityCode: first.tradingEntity!, counterparty: first.counterparty, tradeDate: first.tradeDate!,
      instrument, portfolio: first.portfolio, preTradeReference: first.preTradeReference, custom: Object.assign({}, ...rs.map((r) => r.custom)), legs, rows: rs,
    });
  }
  return { trades, issues };
}

const contentOf = (t: Trade, cancelled: boolean) => sha({ ...t, rows: undefined, key: undefined, cancelled, legs: t.legs.map((l) => ({ ...l, dealAmount: fixed4(l.dealAmount), settlementAmount: l.settlementAmount === null ? null : fixed4(l.settlementAmount) })) });

export function importCommands(db: Db, c: Collaborators) {
  async function writeTrade(tx: Tx, tenant: TenantId, t: Trade, batchId: string | null, version: number, cancelled: boolean, link: { preTradeId: string | null; status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS"; note: string | null; candidates: readonly string[] }): Promise<string> {
    const id = randomUUID();
    await q(tx).insertInto("executed_trades").values({
      tenant_id: tenant, executed_trade_id: id, platform: t.platform, trade_id: t.tradeId, version, is_current: true, cancelled, content_hash: contentOf(t, cancelled), batch_id: batchId,
      program_id: t.programId, trading_entity_code: t.tradingEntityCode, counterparty: t.counterparty, trade_date: t.tradeDate, instrument: t.instrument, portfolio: t.portfolio,
      custom_fields: JSON.stringify(t.custom), pre_trade_reference: t.preTradeReference, pre_trade_id: link.preTradeId, match_status: link.status, match_note: link.note, candidates: JSON.stringify(link.candidates),
    }).execute();
    await q(tx).insertInto("executed_trade_legs").values(t.legs.map((l, i) => ({
      tenant_id: tenant, executed_trade_id: id, leg_no: i + 1, leg_role: l.role, direction: l.direction, deal_currency: l.dealCurrency, deal_amount: fixed4(l.dealAmount),
      settlement_currency: l.settlementCurrency, settlement_amount: fixed4(l.settlementAmount!), value_date: l.valueDate, fixing_date: l.fixingDate,
    }))).execute();
    await announce(tx, { type: "fx-trade.executed-trade-received", tenantId: tenant, executedTradeId: id, programId: t.programId === null ? null : toProgramId(t.programId), preTradeId: link.preTradeId });
    return id;
  }

  async function importExecutedTrades(input: { tenantId: TenantId; rows: readonly ExecutedRow[]; by: string }): Promise<ImportResult> {
    const tenant = input.tenantId;
    const hash = sha(input.rows.map((r) => ({ ...r, rowNo: undefined })));
    const { trades, issues } = assemble(input.rows);

    // Outside services are asked before the transaction opens.
    const catalog = new Set((await c.management.programCatalog(tenant)).map((p) => p.programId as string));
    const byDate = new Map<string, Set<string>>();
    for (const t of trades) byDate.set(t.tradeDate, (byDate.get(t.tradeDate) ?? new Set()).add(t.tradingEntityCode));
    const good = new Map<string, Set<string>>();
    for (const [date, codes] of byDate) {
      const found = await c.masterData.getEntities(tenant, [...codes], asOfDate(date));
      good.set(date, new Set(found.filter((e) => e.isHedgeExecutionEntity).map((e) => e.code)));
      for (const code of codes) if (!found.some((e) => e.code === code)) good.get(date)!.delete(code);
    }
    const storable: Trade[] = [];
    for (const t of trades) {
      if (!good.get(t.tradeDate)!.has(t.tradingEntityCode)) {
        for (const r of t.rows) issues.push({ rowNo: r.rowNo, code: "ENTITY", message: `trading entity ${t.tradingEntityCode} is not a hedge execution entity on ${t.tradeDate}`, raw: r });
      } else storable.push({ ...t, programId: t.programId !== null && catalog.has(t.programId) ? t.programId : null });
    }

    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`fx-trade:${tenant}`}))`.execute(tx);
      const dup = await q(tx).selectFrom("trade_batches").select("batch_id").where("tenant_id", "=", tenant).where("content_hash", "=", hash).executeTakeFirst();
      if (dup) return { status: "DUPLICATE", batchId: dup.batch_id, received: 0, stored: 0, unchanged: 0, blocked: 0, matched: 0, unmatched: 0 } as const;

      const batchId = randomUUID();
      let stored = 0, unchanged = 0, matched = 0, unmatched = 0;
      const touched = new Set<string>();
      for (const t of storable) {
        const current = await q(tx).selectFrom("executed_trades").selectAll().where("tenant_id", "=", tenant).where("platform", "=", t.platform).where("trade_id", "=", t.tradeId).where("is_current", "=", true).forUpdate().executeTakeFirst();
        if (current && current.content_hash === contentOf(t, current.cancelled) && !current.cancelled) { unchanged++; continue; }
        let link;
        if (current && current.pre_trade_id) {
          link = { preTradeId: current.pre_trade_id, status: "MATCHED" as const, note: null, candidates: [] }; // an amendment keeps its pre-trade
        } else {
          const open = t.programId === null ? [] : await openPreTrades(tx, tenant, t.programId);
          const byRef = t.programId !== null && t.preTradeReference !== null ? (await openPreTrades(tx, tenant, t.programId, t.preTradeReference))[0] ?? null : null;
          link = matchTrade({ programId: t.programId, tradingEntityCode: t.tradingEntityCode, instrument: t.instrument, legs: t.legs }, t.preTradeReference, byRef, open);
        }
        if (current) await q(tx).updateTable("executed_trades").set({ is_current: false }).where("tenant_id", "=", tenant).where("executed_trade_id", "=", current.executed_trade_id).execute();
        await writeTrade(tx, tenant, t, batchId, (current?.version ?? 0) + 1, false, link);
        stored++;
        if (link.status === "MATCHED") { matched++; touched.add(link.preTradeId!); } else unmatched++;
      }
      for (const id of touched) await recomputeStatus(tx, tenant, id);

      await q(tx).insertInto("trade_batches").values({ tenant_id: tenant, batch_id: batchId, content_hash: hash, received: input.rows.length, stored, unchanged, blocked: issues.length, created_by: input.by }).execute();
      for (const i of issues) {
        await q(tx).insertInto("trade_issues").values({ tenant_id: tenant, issue_id: randomUUID(), batch_id: batchId, row_no: i.rowNo, code: i.code, message: i.message, raw: JSON.stringify(i.raw) }).execute();
      }
      return { status: "APPLIED", batchId, received: input.rows.length, stored, unchanged, blocked: issues.length, matched, unmatched } as const;
    });
  }

  /** A cancel is a new version marked cancelled; what was received stays. The pre-trade's fill drops back. */
  async function cancelExecutedTrade(input: { tenantId: TenantId; platform: string; tradeId: string; by: string }): Promise<boolean> {
    const tenant = input.tenantId;
    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`fx-trade:${tenant}`}))`.execute(tx);
      const cur = await q(tx).selectFrom("executed_trades").selectAll().where("tenant_id", "=", tenant).where("platform", "=", input.platform).where("trade_id", "=", input.tradeId).where("is_current", "=", true).forUpdate().executeTakeFirst();
      if (!cur) throw new Error(`no executed trade ${input.platform}/${input.tradeId}`);
      if (cur.cancelled) return false;
      const legs = await q(tx).selectFrom("executed_trade_legs").selectAll().where("tenant_id", "=", tenant).where("executed_trade_id", "=", cur.executed_trade_id).orderBy("leg_no").execute();
      const t: Trade = {
        key: "", platform: cur.platform, tradeId: cur.trade_id, programId: cur.program_id, tradingEntityCode: cur.trading_entity_code, counterparty: cur.counterparty, tradeDate: cur.trade_date,
        instrument: cur.instrument, portfolio: cur.portfolio, preTradeReference: cur.pre_trade_reference, custom: (typeof cur.custom_fields === "string" ? JSON.parse(cur.custom_fields) : cur.custom_fields) as Record<string, string>,
        legs: legs.map((l) => ({ role: l.leg_role, direction: l.direction, dealCurrency: l.deal_currency, dealAmount: l.deal_amount, settlementCurrency: l.settlement_currency, settlementAmount: l.settlement_amount, valueDate: l.value_date, fixingDate: l.fixing_date })), rows: [],
      };
      await q(tx).updateTable("executed_trades").set({ is_current: false }).where("tenant_id", "=", tenant).where("executed_trade_id", "=", cur.executed_trade_id).execute();
      await writeTrade(tx, tenant, t, null, cur.version + 1, true, { preTradeId: cur.pre_trade_id, status: cur.match_status, note: cur.match_note, candidates: typeof cur.candidates === "string" ? JSON.parse(cur.candidates) : cur.candidates });
      if (cur.pre_trade_id) await recomputeStatus(tx, tenant, cur.pre_trade_id);
      await recordChange(tx, { tenantId: tenant, programId: cur.program_id === null ? null : toProgramId(cur.program_id), actor: input.by, action: "executed-trade.cancelled", targetType: "executed-trade", targetId: cur.executed_trade_id, fields: [] });
      return true;
    });
  }

  /** A user settles an unmatched or ambiguous trade by naming its pre-trade. The pre-trade must still fit. */
  async function matchByUser(input: { tenantId: TenantId; executedTradeId: string; preTradeId: string; actor: Actor }): Promise<void> {
    const tenant = input.tenantId;
    await db.transaction().execute(async (tx) => {
      const e = await q(tx).selectFrom("executed_trades").selectAll().where("tenant_id", "=", tenant).where("executed_trade_id", "=", input.executedTradeId).forUpdate().executeTakeFirst();
      if (!e || !e.is_current) throw new Error("only the current version of an executed trade can be matched");
      if (e.program_id === null) throw new Error("the trade has no program; it cannot be matched to a pre-trade");
      await require_(c.access, tenant, input.actor, "fx-trade:manage", toProgramId(e.program_id));
      if (e.match_status === "MATCHED") throw new Error("the trade is already matched");
      const legs = await q(tx).selectFrom("executed_trade_legs").selectAll().where("tenant_id", "=", tenant).where("executed_trade_id", "=", e.executed_trade_id).orderBy("leg_no").execute();
      const pre = (await openPreTrades(tx, tenant, e.program_id)).find((p) => p.preTradeId === input.preTradeId);
      if (!pre) throw new Error("that pre-trade is not open in the trade's program");
      const why = misfit({ programId: e.program_id, tradingEntityCode: e.trading_entity_code, instrument: e.instrument, legs: legs.map((l) => ({ role: l.leg_role, direction: l.direction, dealCurrency: l.deal_currency, dealAmount: l.deal_amount, settlementCurrency: l.settlement_currency, settlementAmount: l.settlement_amount, valueDate: l.value_date, fixingDate: l.fixing_date })) }, pre);
      if (why !== null) throw new Error(`the pre-trade does not fit: ${why}`);
      await q(tx).updateTable("executed_trades").set({ pre_trade_id: pre.preTradeId, match_status: "MATCHED", match_note: `matched by ${who(input.actor)}`, candidates: "[]" }).where("tenant_id", "=", tenant).where("executed_trade_id", "=", e.executed_trade_id).execute();
      await announce(tx, { type: "fx-trade.executed-trade-received", tenantId: tenant, executedTradeId: e.executed_trade_id, programId: toProgramId(e.program_id), preTradeId: pre.preTradeId });
      await recomputeStatus(tx, tenant, pre.preTradeId);
      await recordChange(tx, { tenantId: tenant, programId: toProgramId(e.program_id), actor: who(input.actor), action: "executed-trade.matched", targetType: "executed-trade", targetId: e.executed_trade_id, fields: ["pre-trade"] });
    });
  }

  return { importExecutedTrades, cancelExecutedTrade, matchByUser };
}
export { AccessDenied };
export type { ProgramId };
