// Decisions on recommendations, and follow-up from FX Trade (decision 0011 items 10, 11, 13).
//
// A decision is won in one atomic step in this service's own database: the first of accept, override or dismiss to change
// an OPEN recommendation wins, and the others are refused. Only the winner may reach FX Trade. An accept or override records
// its amount and moves to DECIDING; the pre-trade is then made from that recorded amount (FX Trade keys it by the recommendation ID,
// so repeating the call is safe) and a second step confirms it. No transaction spans the two services, and a half-finished
// decision is finished by retrying it or, at cycle approval, settled from what FX Trade holds.
import type { CycleId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import type { FollowUp, Recommendation } from "../contract/index.ts";
import { require_, who } from "./access.ts";
import { lockCycleDecisions } from "./approval.ts";
import { q, type Db, type Tx } from "./db.ts";
import { recordChange } from "./change-record.ts";
import { firstTime } from "./events.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { D as Dec, fmt, splitAmount } from "./calc.ts";
import { withParts } from "./queries.ts";
import type { SplitMethod } from "../contract/index.ts";

export class RecommendationError extends Error {}

export type Decision = "ACCEPT" | "OVERRIDE" | "DISMISS";
const PERMISSION = { ACCEPT: "hedge-recommendation:accept", OVERRIDE: "hedge-recommendation:override", DISMISS: "hedge-recommendation:dismiss" } as const;
const FOLLOW_UP: Record<string, FollowUp> = { DRAFT: "OPEN", READY: "OPEN", SENT: "OPEN", PARTLY_EXECUTED: "PARTLY_EXECUTED", EXECUTED: "EXECUTED", CANCELLED: "CANCELLED" };
/**
 * A recommendation's follow-up from its parts (decisions 0016, 0017): executed when every part is; cancelled when every part is; executed with the rest cancelled
 * when every part is finished, some executed and some cancelled (nothing is left to do, and part of the amount was not hedged); partly executed while any part
 * has been executed or partly filled and another is still live; open otherwise.
 */
export function overallFollowUp(parts: readonly FollowUp[]): FollowUp {
  if (parts.length === 0) return "NOT_STARTED";
  if (parts.every((p) => p === "EXECUTED")) return "EXECUTED";
  if (parts.every((p) => p === "CANCELLED")) return "CANCELLED";
  if (parts.every((p) => p === "EXECUTED" || p === "CANCELLED")) return "EXECUTED_REST_CANCELLED";
  if (parts.some((p) => p === "EXECUTED" || p === "PARTLY_EXECUTED")) return "PARTLY_EXECUTED";
  return parts.every((p) => p === "NOT_STARTED") ? "NOT_STARTED" : "OPEN";
}
const isRefusal = (e: unknown): e is Error & { problems: readonly string[] } => e instanceof Error && Array.isArray((e as { problems?: unknown }).problems);
export interface CycleClosedEvent { readonly eventId: string; readonly tenantId: TenantId; readonly cycleId: CycleId }

export function decideCommands(db: Db, c: Collaborators, clock: () => Date) {
  const read = async (tenant: TenantId, id: string) => q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).executeTakeFirst();
  const reread = async (tenant: TenantId, id: string): Promise<Recommendation> => (await withParts(db, tenant, [(await read(tenant, id))!]))[0]!;
  const partsOf = async (tenant: TenantId, id: string) => q(db).selectFrom("recommendation_parts").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).orderBy("part_no").execute();
  /** The pre-trades FX Trade holds for a recommendation, by part number. They are made together, so it holds all of them or none. */
  const preTradesOf = async (tenant: TenantId, cycle: string, recommendationId: string): Promise<Map<number, string>> =>
    new Map((await c.preTrades.preTrades(tenant, { cycleId: cycle as CycleId })).filter((p) => p.recommendationId === recommendationId && p.partNo !== null).map((p) => [p.partNo!, p.preTradeId] as const));

  /** (Re)write a recommendation's parts, and the note that explains them, from an amount split the way the recommendation was (decision 0016). Called inside the claim, and to put the original parts and note back. */
  async function writeParts(tx: Tx, tenant: TenantId, rec: { recommendation_id: string; program_id: string; max_exposure_amount: string | null; split_method: string | null; min_exposure_amount: string | null; rounding: string }, total: string): Promise<void> {
    // A rolled recommendation (decision 0021) keeps its close-outs and its roll as they are: only the adjustment changes. When the adjustment is booked with the roll
    // as one trade, that one trade takes the amount and is not split.
    const have = await q(tx).selectFrom("recommendation_parts").select(["part_no", "role"]).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).execute();
    const fixed = have.filter((x) => x.role === "CLOSE_OUT" || x.role === "ROLL").length;
    const combined = have.some((x) => x.role === "COMBINED");
    await q(tx).deleteFrom("recommendation_parts").where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("role", "in", ["ADJUSTMENT", "COMBINED"]).execute();
    if (combined) {
      await q(tx).insertInto("recommendation_parts").values({ tenant_id: tenant, recommendation_id: rec.recommendation_id, program_id: rec.program_id, part_no: fixed + 1, role: "COMBINED", amount: fmt(new Dec(total)) }).execute();
      await q(tx).updateTable("recommendations").set({ split_note: null }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).execute();
      return;
    }
    const split = splitAmount(new Dec(total), rec.max_exposure_amount === null ? null : new Dec(rec.max_exposure_amount), (rec.split_method ?? "EVEN") as SplitMethod, new Dec(rec.rounding), rec.min_exposure_amount === null ? null : new Dec(rec.min_exposure_amount));
    await q(tx).insertInto("recommendation_parts").values(split.parts.map((part, i) => ({ tenant_id: tenant, recommendation_id: rec.recommendation_id, program_id: rec.program_id, part_no: fixed + i + 1, role: "ADJUSTMENT" as const, amount: fmt(part) }))).execute();
    await q(tx).updateTable("recommendations").set({ split_note: split.note }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).execute();
  }

  /** Second step: every part's pre-trade exists, so record the decision as taken. Only the first to get here announces. */
  async function confirm(tenant: TenantId, id: string, preTrades: ReadonlyMap<number, string>): Promise<Recommendation> {
    await db.transaction().execute(async (tx) => {
      const rec = await q(tx).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).forUpdate().executeTakeFirstOrThrow();
      if (rec.status !== "DECIDING") return;
      await q(tx).updateTable("recommendations").set({ status: rec.decision_kind === "OVERRIDE" ? "OVERRIDDEN" : "ACCEPTED", follow_up: "OPEN" }).where("tenant_id", "=", tenant).where("recommendation_id", "=", id).execute();
      for (const [partNo, preTradeId] of [...preTrades].sort(([x], [y]) => x - y)) {
        await q(tx).updateTable("recommendation_parts").set({ pre_trade_id: preTradeId, follow_up: "OPEN" }).where("tenant_id", "=", tenant).where("recommendation_id", "=", id).where("part_no", "=", partNo).execute();
        await announce(tx, { type: "hedge-recommendation.pre-trade-created", tenantId: tenant, recommendationId: id, preTradeId, partNo, cycleId: rec.cycle_id as CycleId, programId: rec.program_id as never });
      }
      // The decision stands once its pre-trades exist, so this is where it is written to the trail: in the transaction that confirms it, once, by whoever won the claim.
      await recordChange(tx, { tenantId: tenant, programId: rec.program_id as never, actor: rec.decided_by!, action: rec.decision_kind === "OVERRIDE" ? "recommendation.overridden" : "recommendation.accepted", targetType: "recommendation", targetId: id, fields: rec.decision_kind === "OVERRIDE" ? ["amount"] : [] });
    });
    // FX Trade may have changed a draft (cancelled it) after creating it and before the links above were durable; its event then found no part to update.
    // So once the links are in, bring each part up to FX Trade's current state. This is best effort: the decision is already committed, so a failed read must not
    // make it look failed. The `pre-trade-created` events announced above reconcile each part through the dispatcher, and stay pending until that succeeds.
    for (const preTradeId of preTrades.values()) { try { await refreshFollowUp(tenant, preTradeId); } catch { /* retried by the event */ } }
    return reread(tenant, id);
  }

  /** A decision that won but has no pre-trades yet: make them (or find them) from the recorded parts, all in one call to FX Trade, then confirm. */
  async function complete(tenant: TenantId, id: string): Promise<Recommendation> {
    const rec = (await read(tenant, id))!;
    if (rec.status !== "DECIDING") return reread(tenant, id);
    const parts = await partsOf(tenant, id);
    try {
      const made = await c.createPreTrades({
        tenantId: tenant, cycleId: rec.cycle_id as CycleId, by: rec.decided_by!,
        items: parts.map((part) => {
          // A close-out and the roll carry their own direction and dates; an adjustment (or the combined trade) takes the recommendation's.
          const own = part.value_date !== null;
          return {
            recommendationId: id, partNo: part.part_no, tradingEntityCode: (part.trading_entity_code ?? rec.trading_entity_code)!, instrument: rec.instrument as "FORWARD" | "NDF",
            legs: [{ role: "SINGLE" as const, direction: (part.direction ?? rec.direction) as "BUY" | "SELL", dealCurrency: rec.exposure_currency, dealAmount: part.amount, settlementCurrency: rec.other_currency, settlementAmount: null, valueDate: part.value_date ?? rec.value_date!, fixingDate: own ? part.fixing_date : rec.fixing_date }],
          };
        }),
      });
      const byPart = new Map(made.map((m) => [m.partNo, m.preTradeId] as const));
      if (parts.some((part) => !byPart.has(part.part_no))) throw new RecommendationError("FX Trade did not return a pre-trade for every part");
      return await confirm(tenant, id, byPart);
    } catch (e) {
      // The call may have succeeded before it failed, so look before deciding what the failure meant. FX Trade makes the parts together: all or none.
      const found = await preTradesOf(tenant, rec.cycle_id, id);
      if (parts.length > 0 && parts.every((part) => found.has(part.part_no))) return confirm(tenant, id, found);
      if (!isRefusal(e)) throw e; // could not tell what happened: the decision stays recorded and retrying it finishes it
      // FX Trade refused outright and holds nothing: the recommendation goes back to open for a user to change or dismiss,
      // or lapses if the cycle was approved or closed in the meantime. Its parts go back to the recommended amount.
      const cycle = await c.management.getCycle(tenant, rec.cycle_id as CycleId);
      const closed = !cycle || cycle.approvedAt !== null || cycle.outcome !== null;
      await db.transaction().execute(async (tx) => {
        const back = await q(tx).updateTable("recommendations").set({ status: closed ? "LAPSED" : "OPEN", decision_kind: null, decided_amount: null, decided_by: null, decided_at: null, decision_note: null })
          .where("tenant_id", "=", tenant).where("recommendation_id", "=", id).where("status", "=", "DECIDING").executeTakeFirst();
        if (Number(back.numUpdatedRows) > 0 && rec.amount !== null) await writeParts(tx, tenant, rec, rec.amount);
      });
      throw new RecommendationError(`FX Trade refused the pre-trade: ${e.problems.join("; ")}`);
    }
  }

  async function decide(input: { tenantId: TenantId; recommendationId: string; actor: Actor; action: Decision; amount?: string; note?: string }): Promise<Recommendation> {
    const { tenantId: tenant } = input;
    const rec = await read(tenant, input.recommendationId);
    if (!rec) throw new RecommendationError(`recommendation ${input.recommendationId} does not exist`);
    await require_(c.access, tenant, input.actor, PERMISSION[input.action], rec.program_id as never);

    if (rec.status === "DECIDING") {
      // Retrying the decision that won finishes it; any other decision is refused while it is in progress.
      if (input.action === "DISMISS" || input.action !== rec.decision_kind) throw new RecommendationError(`a ${rec.decision_kind!.toLowerCase()} is already in progress for this recommendation`);
      return complete(tenant, rec.recommendation_id);
    }
    if (rec.action !== "HEDGE" || rec.status !== "OPEN") throw new RecommendationError(`the recommendation is ${rec.status.toLowerCase()} and cannot be decided`);
    const cycle = await c.management.getCycle(tenant, rec.cycle_id as never);
    if (!cycle || cycle.approvedAt !== null || cycle.outcome !== null) throw new RecommendationError("the cycle is approved or closed; recommendations can no longer be decided");
    // Approve Exposure comes first (decision 0011 item 17): before it a recommendation is a preview, and only the approved run's recommendations can be decided.
    if (cycle.exposureApprovedAt === null) throw new RecommendationError("the exposure has not been approved; approve the exposure before deciding recommendations");
    if (cycle.exposureApprovedRunId !== rec.run_id) throw new RecommendationError("this recommendation was made from a run other than the approved one and cannot be decided");
    const by = who(input.actor);
    const note = input.note ?? null;
    const lost = async (): Promise<never> => {
      const now = (await read(tenant, rec.recommendation_id))!;
      throw new RecommendationError(`the recommendation was ${now.status === "DECIDING" ? "decided" : now.status.toLowerCase()} by someone else first`);
    };

    if (input.action === "DISMISS") {
      // The winning decision and its change record are written together, so a decision that lost leaves nothing in the trail.
      const won = await db.transaction().execute(async (tx) => {
        const r = await q(tx).updateTable("recommendations").set({ status: "DISMISSED", decided_by: by, decided_at: clock(), decision_note: note }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) return false;
        await recordChange(tx, { tenantId: tenant, programId: rec.program_id as never, actor: by, action: "recommendation.dismissed", targetType: "recommendation", targetId: rec.recommendation_id, fields: note === null ? [] : ["note"] });
        return true;
      });
      if (!won) return lost();
      return reread(tenant, rec.recommendation_id);
    }

    let amount = rec.amount;
    if (input.action === "OVERRIDE") {
      // A rolled recommendation can be overridden only where it has an adjustment (or a combined far trade); the close-outs and the roll are what is maturing (decision 0021).
      if (rec.amount === null) throw new RecommendationError("there is no adjustment to override: this recommendation only closes and rolls the maturing hedges");
      if (input.amount === undefined || !/^\d+(\.\d{1,4})?$/.test(input.amount) || Number(input.amount) <= 0) throw new RecommendationError("an override needs a positive amount with up to 4 decimals");
      amount = input.amount;
    }
    if ((await partsOf(tenant, rec.recommendation_id)).some((part) => (part.trading_entity_code ?? rec.trading_entity_code) === null)) throw new RecommendationError("this recommendation has no trading entity");
    // Claiming is not yet a decision: FX Trade may still refuse, which reopens the recommendation. Audit hears of it when it is confirmed.
    // The claim takes the cycle's decision lock and looks for a reservation by this same person (an Approve Cycle in flight, decision 0013), so
    // a person cannot win a decision and an approval of the same cycle at once.
    const claim = await db.transaction().execute(async (tx) => {
      await lockCycleDecisions(tx, tenant, rec.cycle_id);
      // A roll was made from the dates as they were (decision 0021). The dates change under this same lock, and the approval of the exposure refuses while they differ, so this
      // only stops a recommendation whose dates have moved on since; it is decided after a rerun or not at all.
      if (rec.roll_type !== null) {
        const now = await q(tx).selectFrom("roll_parameters").select("revision").where("tenant_id", "=", tenant).where("cycle_id", "=", rec.cycle_id).executeTakeFirst();
        if ((now?.revision ?? null) !== rec.roll_revision) throw new RecommendationError("the roll dates changed after this recommendation was made; rerun the cycle");
      }
      const reserved = await q(tx).selectFrom("approval_holds").select("hold_id").where("tenant_id", "=", tenant).where("cycle_id", "=", rec.cycle_id).where("approver", "=", by).limit(1).executeTakeFirst();
      if (reserved) return "RESERVED" as const;
      const r = await q(tx).updateTable("recommendations").set({ status: "DECIDING", decision_kind: input.action, decided_amount: amount, decided_by: by, decided_at: clock(), decision_note: note })
        .where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return "LOST" as const;
      // An override is split the way the recommendation was: its amount against the same maximum, method and minimum (decision 0016).
      if (input.action === "OVERRIDE") await writeParts(tx, tenant, rec, amount!);
      return "WON" as const;
    });
    if (claim === "RESERVED") throw new RecommendationError("segregation of duties: you are approving this cycle, so someone else must decide its hedge recommendations");
    if (claim === "LOST") return lost();
    return complete(tenant, rec.recommendation_id);
  }

  /** Approval, skip or deletion of a cycle: what nobody decided lapses; a decision that won but never got its pre-trade is settled from what FX Trade holds. */
  async function onCycleClosed(event: CycleClosedEvent): Promise<number> {
    const { tenantId: tenant } = event;
    // The cycle can no longer be approved, so no approval is in flight: clear any reservation left behind (decision 0013).
    await q(db).deleteFrom("approval_holds").where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).execute();
    const deciding = await q(db).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "=", "DECIDING").execute();
    const held = new Map<string, Map<number, string>>();
    for (const p of await c.preTrades.preTrades(tenant, { cycleId: event.cycleId })) {
      if (p.recommendationId === null || p.partNo === null) continue;
      held.set(p.recommendationId, (held.get(p.recommendationId) ?? new Map()).set(p.partNo, p.preTradeId));
    }
    let changed = 0;
    for (const d of deciding) {
      const pre = held.get(d.recommendation_id);
      const parts = await partsOf(tenant, d.recommendation_id);
      if (pre && parts.length > 0 && parts.every((part) => pre.has(part.part_no))) { await confirm(tenant, d.recommendation_id, pre); changed++; continue; }
      // No pre-trade exists and the cycle can no longer take one, so this decision did not take effect. An override had re-split the amount: put the original
      // parts and note back in the same transaction that lapses it, as a refusal does, so the read model never shows parts that do not add up to the amount.
      await db.transaction().execute(async (tx) => {
        const rec = await q(tx).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", d.recommendation_id).forUpdate().executeTakeFirst();
        if (!rec || rec.status !== "DECIDING") return;
        await q(tx).updateTable("recommendations").set({ status: "LAPSED", decision_kind: null, decided_amount: null, decided_by: null, decided_at: null, decision_note: null })
          .where("tenant_id", "=", tenant).where("recommendation_id", "=", d.recommendation_id).execute();
        if (rec.decision_kind === "OVERRIDE") await writeParts(tx, tenant, rec, rec.amount!);
      });
      changed++;
    }
    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, tenant, event.eventId))) return changed;
      const r = await q(tx).updateTable("recommendations").set({ status: "LAPSED" }).where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "=", "OPEN").executeTakeFirst();
      return changed + Number(r.numUpdatedRows);
    });
  }

  /** A pre-trade changed or an executed trade arrived: bring the follow-up of its part, and so of its recommendation, up to date. */
  async function refreshFollowUp(tenant: TenantId, preTradeId: string): Promise<boolean> {
    const part = await q(db).selectFrom("recommendation_parts").select(["recommendation_id", "part_no", "follow_up"]).where("tenant_id", "=", tenant).where("pre_trade_id", "=", preTradeId).executeTakeFirst();
    if (!part) return false;
    const pre = await c.preTrades.getPreTrade(tenant, preTradeId);
    const next = pre ? FOLLOW_UP[pre.status] : undefined;
    if (!next || next === part.follow_up) return false;
    await db.transaction().execute(async (tx) => {
      await q(tx).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("recommendation_id", "=", part.recommendation_id).forUpdate().executeTakeFirst();
      await q(tx).updateTable("recommendation_parts").set({ follow_up: next }).where("tenant_id", "=", tenant).where("recommendation_id", "=", part.recommendation_id).where("part_no", "=", part.part_no).execute();
      const all = await q(tx).selectFrom("recommendation_parts").select("follow_up").where("tenant_id", "=", tenant).where("recommendation_id", "=", part.recommendation_id).execute();
      await q(tx).updateTable("recommendations").set({ follow_up: overallFollowUp(all.map((x) => x.follow_up as FollowUp)) }).where("tenant_id", "=", tenant).where("recommendation_id", "=", part.recommendation_id).execute();
    });
    return true;
  }

  return { decide, onCycleClosed, refreshFollowUp };
}
