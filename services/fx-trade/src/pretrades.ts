// Pre-trades: made from recommendations or by hand, released on approval or by a user, sent out as a file.
import { randomUUID } from "node:crypto";
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";
import { asOfDate, programId as toProgramId } from "@shared/kernel";
import type { CycleApproved, CycleDeleted, CycleSkipped } from "@services/exposure-management/contract";
import type { Actor } from "@services/identity/contract";
import type { Instrument } from "../contract/index.ts";
import { AccessDenied, require_, who } from "./access.ts";
import { q, type Db, type Queryable, type Tx } from "./db.ts";
import { toPreTradeFile, type OutRow } from "./file.ts";
import { fixed4, legProblems, type LegInput } from "./model.ts";
import { recordChange } from "./change-record.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { readPreTrades, recomputeStatus } from "./store.ts";

export class PreTradeInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join("; "));
    this.problems = problems;
  }
}

export interface NewPreTradeBody {
  readonly tradingEntityCode: string;
  readonly instrument: Instrument;
  readonly legs: readonly LegInput[];
}
export interface RecommendedPreTrade extends NewPreTradeBody {
  /** With the part number, the idempotency key: sending the same recommendation part again returns the pre-trade already made. */
  readonly recommendationId: string;
  /** Which part of the recommendation, from 1; a recommendation that is not split is part 1 (the default). */
  readonly partNo?: number;
}
export interface Created {
  readonly recommendationId: string;
  readonly partNo: number;
  readonly preTradeId: string;
  readonly reference: string;
  readonly created: boolean;
}

const referenceOf = (id: string): string => `PT-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`;

export function preTradeCommands(db: Db, c: Collaborators, clock: () => Date) {
  /** Shape of the legs, and that the trading entity is a hedge execution entity on the date. */
  async function problemsOf(tenant: TenantId, body: NewPreTradeBody, onDate: string): Promise<string[]> {
    const out = legProblems(body.instrument, body.legs, false);
    if (out.length > 0) return out;
    const [entity] = await c.masterData.getEntities(tenant, [body.tradingEntityCode], asOfDate(onDate));
    if (!entity) out.push(`trading entity ${body.tradingEntityCode} is not on record on ${onDate}`);
    else if (!entity.isHedgeExecutionEntity) out.push(`trading entity ${body.tradingEntityCode} is not a hedge execution entity`);
    return out;
  }

  async function insert(tx: Tx, tenant: TenantId, program: string, cycle: string | null, recommendationId: string | null, partNo: number | null, origin: "RECOMMENDATION" | "MANUAL", body: NewPreTradeBody, by: string) {
    const preTradeId = randomUUID();
    await q(tx).insertInto("pre_trades").values({
      tenant_id: tenant, pre_trade_id: preTradeId, reference: referenceOf(preTradeId), program_id: program, cycle_id: cycle, recommendation_id: recommendationId, part_no: partNo,
      origin, status: "DRAFT", trading_entity_code: body.tradingEntityCode, instrument: body.instrument, released_at: null, sent_at: null, created_by: by,
    }).execute();
    await q(tx).insertInto("pre_trade_legs").values(body.legs.map((l, i) => ({
      tenant_id: tenant, pre_trade_id: preTradeId, leg_no: i + 1, leg_role: l.role, direction: l.direction, deal_currency: l.dealCurrency, deal_amount: fixed4(l.dealAmount),
      settlement_currency: l.settlementCurrency, settlement_amount: l.settlementAmount === null ? null : fixed4(l.settlementAmount), value_date: l.valueDate, fixing_date: l.fixingDate,
    }))).execute();
    return { preTradeId, reference: referenceOf(preTradeId) };
  }

  /** From Hedge Recommendation, for a cycle that is open and not yet approved. All or nothing. */
  async function createPreTrades(input: { tenantId: TenantId; cycleId: CycleId; items: readonly RecommendedPreTrade[]; by: string }): Promise<Created[]> {
    const cycle = await c.management.getCycle(input.tenantId, input.cycleId);
    if (!cycle) throw new PreTradeInvalid([`cycle ${input.cycleId} does not exist`]);
    if (cycle.outcome !== null || cycle.approvedAt !== null) throw new PreTradeInvalid(["pre-trades can only be added to an open cycle that is not approved"]);
    const problems: string[] = [];
    const seen = new Set<string>();
    const keyOf = (item: RecommendedPreTrade) => `${item.recommendationId}#${item.partNo ?? 1}`;
    for (const [i, item] of input.items.entries()) {
      if (!Number.isInteger(item.partNo ?? 1) || (item.partNo ?? 1) < 1) problems.push(`item ${i + 1}: the part number must be a whole number from 1`);
      if (seen.has(keyOf(item))) problems.push(`item ${i + 1}: part ${item.partNo ?? 1} of recommendation ${item.recommendationId} appears twice`);
      seen.add(keyOf(item));
    }
    const existing = new Map((await readPreTrades(db, input.tenantId, { recommendationIds: [...new Set(input.items.map((i) => i.recommendationId))] })).map((p) => [`${p.recommendationId}#${p.partNo}`, p]));
    for (const [i, item] of input.items.entries()) {
      if (existing.has(keyOf(item))) continue;
      for (const p of await problemsOf(input.tenantId, item, cycle.asOf)) problems.push(`item ${i + 1} (${item.recommendationId}): ${p}`);
    }
    if (problems.length > 0) throw new PreTradeInvalid(problems);

    return db.transaction().execute(async (tx) => {
      const out: Created[] = [];
      for (const item of input.items) {
        const partNo = item.partNo ?? 1;
        const known = existing.get(keyOf(item));
        if (known) { out.push({ recommendationId: item.recommendationId, partNo, preTradeId: known.preTradeId, reference: known.reference, created: false }); continue; }
        const made = await insert(tx, input.tenantId, cycle.programId, cycle.cycleId, item.recommendationId, partNo, "RECOMMENDATION", item, input.by);
        out.push({ recommendationId: item.recommendationId, partNo, ...made, created: true });
      }
      return out;
    });
  }

  async function createManualPreTrade(input: { tenantId: TenantId; programId: ProgramId; body: NewPreTradeBody; actor: Actor }): Promise<{ preTradeId: string; reference: string }> {
    await require_(c.access, input.tenantId, input.actor, "fx-trade:manage", input.programId);
    const program = (await c.management.programCatalog(input.tenantId)).find((p) => p.programId === input.programId);
    if (!program || !program.enabled) throw new PreTradeInvalid([`program ${input.programId} is not enabled`]);
    const problems = await problemsOf(input.tenantId, input.body, clock().toISOString().slice(0, 10));
    if (problems.length > 0) throw new PreTradeInvalid(problems);
    return db.transaction().execute(async (tx) => {
      const made = await insert(tx, input.tenantId, input.programId, null, null, null, "MANUAL", input.body, who(input.actor));
      await recordChange(tx, { tenantId: input.tenantId, programId: input.programId, actor: who(input.actor), action: "pre-trade.created", targetType: "pre-trade", targetId: made.preTradeId, fields: [] });
      return made;
    });
  }

  async function release(tx: Tx, tenant: TenantId, preTradeId: string, program: string, cycle: string | null): Promise<void> {
    await q(tx).updateTable("pre_trades").set({ status: "READY", released_at: clock() }).where("tenant_id", "=", tenant).where("pre_trade_id", "=", preTradeId).execute();
    await announce(tx, { type: "fx-trade.pre-trade-ready", tenantId: tenant, preTradeId, programId: toProgramId(program), cycleId: cycle as CycleId | null });
  }

  /** A user releases a manual pre-trade. One from a recommendation waits for its cycle to be approved. */
  async function releasePreTrade(input: { tenantId: TenantId; preTradeId: string; actor: Actor }): Promise<boolean> {
    return db.transaction().execute(async (tx) => {
      const p = await q(tx).selectFrom("pre_trades").selectAll().where("tenant_id", "=", input.tenantId).where("pre_trade_id", "=", input.preTradeId).forUpdate().executeTakeFirst();
      if (!p) throw new PreTradeInvalid([`pre-trade ${input.preTradeId} does not exist`]);
      await require_(c.access, input.tenantId, input.actor, "fx-trade:manage", toProgramId(p.program_id));
      if (p.origin !== "MANUAL") throw new PreTradeInvalid(["a pre-trade from a recommendation is released when its cycle is approved"]);
      if (p.status !== "DRAFT") return false;
      await release(tx, input.tenantId, p.pre_trade_id, p.program_id, p.cycle_id);
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(p.program_id), actor: who(input.actor), action: "pre-trade.released", targetType: "pre-trade", targetId: p.pre_trade_id, fields: [] });
      return true;
    });
  }

  async function cancelPreTrade(input: { tenantId: TenantId; preTradeId: string; actor: Actor }): Promise<boolean> {
    return db.transaction().execute(async (tx) => {
      const p = await q(tx).selectFrom("pre_trades").select(["program_id", "status", "cycle_id"]).where("tenant_id", "=", input.tenantId).where("pre_trade_id", "=", input.preTradeId).forUpdate().executeTakeFirst();
      if (!p) throw new PreTradeInvalid([`pre-trade ${input.preTradeId} does not exist`]);
      await require_(c.access, input.tenantId, input.actor, "fx-trade:manage", toProgramId(p.program_id));
      if (p.status === "CANCELLED") return false;
      if (!["DRAFT", "READY", "SENT"].includes(p.status)) throw new PreTradeInvalid([`a ${p.status.toLowerCase().replace("_", " ")} pre-trade cannot be cancelled`]);
      await q(tx).updateTable("pre_trades").set({ status: "CANCELLED" }).where("tenant_id", "=", input.tenantId).where("pre_trade_id", "=", input.preTradeId).execute();
      await announce(tx, { type: "fx-trade.pre-trade-cancelled", tenantId: input.tenantId, preTradeId: input.preTradeId, programId: toProgramId(p.program_id), cycleId: p.cycle_id as CycleId | null });
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(p.program_id), actor: who(input.actor), action: "pre-trade.cancelled", targetType: "pre-trade", targetId: input.preTradeId, fields: [] });
      return true;
    });
  }

  /** The ready pre-trades as the outbound file; they become sent. Nothing ready gives a header-only file. */
  async function exportPreTrades(input: { tenantId: TenantId; programId?: ProgramId; actor: Actor }): Promise<{ file: string; preTradeIds: string[] }> {
    await (input.programId ? require_(c.access, input.tenantId, input.actor, "fx-trade:manage", input.programId) : require_(c.access, input.tenantId, input.actor, "fx-trade:manage"));
    return db.transaction().execute(async (tx) => {
      const ready = await readPreTrades(tx, input.tenantId, { status: "READY", ...(input.programId ? { programId: input.programId } : {}) });
      const rows: OutRow[] = ready.flatMap((p) => p.legs.map((l) => ({
        reference: p.reference, programId: p.programId, tradingEntity: p.tradingEntityCode, instrument: p.instrument, leg: l.role, buySell: l.direction,
        dealCurrency: l.dealCurrency, dealAmount: l.dealAmount, settlementCurrency: l.settlementCurrency, settlementAmount: l.settlementAmount, valueDate: l.valueDate, fixingDate: l.fixingDate,
      })));
      if (ready.length > 0) {
        await q(tx).updateTable("pre_trades").set({ status: "SENT", sent_at: clock() }).where("tenant_id", "=", input.tenantId).where("pre_trade_id", "in", ready.map((p) => p.preTradeId)).where("status", "=", "READY").execute();
        for (const p of ready) await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(p.programId), actor: who(input.actor), action: "pre-trade.sent", targetType: "pre-trade", targetId: p.preTradeId, fields: [] });
      }
      return { file: toPreTradeFile(rows), preTradeIds: ready.map((p) => p.preTradeId) };
    });
  }

  async function firstTime(tx: Queryable, tenant: TenantId, eventId: string): Promise<boolean> {
    const r = await q(tx).insertInto("handled_events").values({ tenant_id: tenant, event_id: eventId }).onConflict((oc) => oc.doNothing()).executeTakeFirst();
    return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  /** The release gate: approval makes the cycle's drafts ready and announces each. Safe to repeat. */
  async function onCycleApproved(e: CycleApproved): Promise<number> {
    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, e.tenantId, e.eventId))) return 0;
      const drafts = await q(tx).selectFrom("pre_trades").select(["pre_trade_id", "program_id", "cycle_id"]).where("tenant_id", "=", e.tenantId).where("cycle_id", "=", e.cycleId).where("status", "=", "DRAFT").orderBy("created_at").orderBy("reference").forUpdate().execute();
      for (const d of drafts) await release(tx, e.tenantId, d.pre_trade_id, d.program_id, d.cycle_id);
      return drafts.length;
    });
  }

  /** A cycle skipped or deleted before approval never releases its drafts. */
  async function onCycleClosed(e: CycleSkipped | CycleDeleted): Promise<number> {
    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, e.tenantId, e.eventId))) return 0;
      const cancelled = await q(tx).updateTable("pre_trades").set({ status: "CANCELLED" }).where("tenant_id", "=", e.tenantId).where("cycle_id", "=", e.cycleId).where("status", "=", "DRAFT").returning(["pre_trade_id", "program_id", "cycle_id"]).execute();
      for (const d of cancelled) await announce(tx, { type: "fx-trade.pre-trade-cancelled", tenantId: e.tenantId, preTradeId: d.pre_trade_id, programId: toProgramId(d.program_id), cycleId: d.cycle_id as CycleId | null });
      return cancelled.length;
    });
  }

  return { createPreTrades, createManualPreTrade, releasePreTrade, cancelPreTrade, exportPreTrades, onCycleApproved, onCycleClosed, recomputeStatus: (tenant: TenantId, id: string) => db.transaction().execute((tx) => recomputeStatus(tx, tenant, id)) };
}
export { AccessDenied };
