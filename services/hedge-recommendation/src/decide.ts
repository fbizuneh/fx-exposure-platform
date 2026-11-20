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
import { q, type Db } from "./db.ts";
import { firstTime } from "./events.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { toRecommendation } from "./queries.ts";

export class RecommendationError extends Error {}

export type Decision = "ACCEPT" | "OVERRIDE" | "DISMISS";
const PERMISSION = { ACCEPT: "hedge-recommendation:accept", OVERRIDE: "hedge-recommendation:override", DISMISS: "hedge-recommendation:dismiss" } as const;
const FOLLOW_UP: Record<string, FollowUp> = { DRAFT: "OPEN", READY: "OPEN", SENT: "OPEN", PARTLY_EXECUTED: "PARTLY_EXECUTED", EXECUTED: "EXECUTED", CANCELLED: "CANCELLED" };
const isRefusal = (e: unknown): e is Error & { problems: readonly string[] } => e instanceof Error && Array.isArray((e as { problems?: unknown }).problems);
export interface CycleClosedEvent { readonly eventId: string; readonly tenantId: TenantId; readonly cycleId: CycleId }

export function decideCommands(db: Db, c: Collaborators, clock: () => Date) {
  const read = async (tenant: TenantId, id: string) => q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).executeTakeFirst();
  const reread = async (tenant: TenantId, id: string): Promise<Recommendation> => toRecommendation((await read(tenant, id))!);
  const preTradeOf = async (tenant: TenantId, cycle: string, recommendationId: string) => (await c.preTrades.preTrades(tenant, { cycleId: cycle as CycleId })).find((p) => p.recommendationId === recommendationId) ?? null;

  /** Second step: the pre-trade exists, so record the decision as taken. Only the first to get here announces. */
  async function confirm(tenant: TenantId, id: string, preTradeId: string): Promise<Recommendation> {
    await db.transaction().execute(async (tx) => {
      const rec = await q(tx).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).forUpdate().executeTakeFirstOrThrow();
      if (rec.status !== "DECIDING") return;
      await q(tx).updateTable("recommendations").set({ status: rec.decision_kind === "OVERRIDE" ? "OVERRIDDEN" : "ACCEPTED", pre_trade_id: preTradeId, follow_up: "OPEN" }).where("tenant_id", "=", tenant).where("recommendation_id", "=", id).execute();
      await announce(tx, { type: "hedge-recommendation.pre-trade-created", tenantId: tenant, recommendationId: id, preTradeId, cycleId: rec.cycle_id as CycleId, programId: rec.program_id as never });
    });
    return reread(tenant, id);
  }

  /** A decision that won but has no pre-trade yet: make it (or find it) from the recorded amount, then confirm. */
  async function complete(tenant: TenantId, id: string): Promise<Recommendation> {
    const rec = (await read(tenant, id))!;
    if (rec.status !== "DECIDING") return toRecommendation(rec);
    try {
      const [made] = await c.createPreTrades({
        tenantId: tenant, cycleId: rec.cycle_id as CycleId, by: rec.decided_by!,
        items: [{
          recommendationId: id, tradingEntityCode: rec.trading_entity_code!, instrument: rec.instrument as "FORWARD" | "NDF",
          legs: [{ role: "SINGLE", direction: rec.direction as "BUY" | "SELL", dealCurrency: rec.exposure_currency, dealAmount: rec.decided_amount!, settlementCurrency: rec.other_currency, settlementAmount: null, valueDate: rec.value_date!, fixingDate: rec.fixing_date }],
        }],
      });
      if (!made) throw new RecommendationError("FX Trade did not return a pre-trade");
      return await confirm(tenant, id, made.preTradeId);
    } catch (e) {
      // The call may have succeeded before it failed, so look before deciding what the failure meant.
      const found = await preTradeOf(tenant, rec.cycle_id, id);
      if (found) return confirm(tenant, id, found.preTradeId);
      if (!isRefusal(e)) throw e; // could not tell what happened: the decision stays recorded and retrying it finishes it
      // FX Trade refused outright and holds nothing: the recommendation goes back to open for a user to change or dismiss,
      // or lapses if the cycle was approved or closed in the meantime.
      const cycle = await c.management.getCycle(tenant, rec.cycle_id as CycleId);
      const closed = !cycle || cycle.approvedAt !== null || cycle.outcome !== null;
      await q(db).updateTable("recommendations").set({ status: closed ? "LAPSED" : "OPEN", decision_kind: null, decided_amount: null, decided_by: null, decided_at: null, decision_note: null })
        .where("tenant_id", "=", tenant).where("recommendation_id", "=", id).where("status", "=", "DECIDING").execute();
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
    const by = who(input.actor);
    const note = input.note ?? null;
    const lost = async (): Promise<never> => {
      const now = (await read(tenant, rec.recommendation_id))!;
      throw new RecommendationError(`the recommendation was ${now.status === "DECIDING" ? "decided" : now.status.toLowerCase()} by someone else first`);
    };

    if (input.action === "DISMISS") {
      const r = await q(db).updateTable("recommendations").set({ status: "DISMISSED", decided_by: by, decided_at: clock(), decision_note: note }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return lost();
      return reread(tenant, rec.recommendation_id);
    }

    let amount = rec.amount!;
    if (input.action === "OVERRIDE") {
      if (input.amount === undefined || !/^\d+(\.\d{1,4})?$/.test(input.amount) || Number(input.amount) <= 0) throw new RecommendationError("an override needs a positive amount with up to 4 decimals");
      amount = input.amount;
    }
    if (rec.trading_entity_code === null) throw new RecommendationError("this recommendation has no trading entity");
    const won = await q(db).updateTable("recommendations").set({ status: "DECIDING", decision_kind: input.action, decided_amount: amount, decided_by: by, decided_at: clock(), decision_note: note })
      .where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").executeTakeFirst();
    if (Number(won.numUpdatedRows) === 0) return lost();
    return complete(tenant, rec.recommendation_id);
  }

  /** Approval, skip or deletion of a cycle: what nobody decided lapses; a decision that won but never got its pre-trade is settled from what FX Trade holds. */
  async function onCycleClosed(event: CycleClosedEvent): Promise<number> {
    const { tenantId: tenant } = event;
    const deciding = await q(db).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "=", "DECIDING").execute();
    const held = new Map((await c.preTrades.preTrades(tenant, { cycleId: event.cycleId })).filter((p) => p.recommendationId !== null).map((p) => [p.recommendationId!, p.preTradeId]));
    let changed = 0;
    for (const d of deciding) {
      const pre = held.get(d.recommendation_id);
      if (pre) { await confirm(tenant, d.recommendation_id, pre); changed++; continue; }
      // No pre-trade exists and the cycle can no longer take one, so this decision did not take effect.
      await q(db).updateTable("recommendations").set({ status: "LAPSED", decision_kind: null, decided_amount: null, decided_by: null, decided_at: null, decision_note: null })
        .where("tenant_id", "=", tenant).where("recommendation_id", "=", d.recommendation_id).where("status", "=", "DECIDING").execute();
      changed++;
    }
    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, tenant, event.eventId))) return changed;
      const r = await q(tx).updateTable("recommendations").set({ status: "LAPSED" }).where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "=", "OPEN").executeTakeFirst();
      return changed + Number(r.numUpdatedRows);
    });
  }

  /** A pre-trade changed or an executed trade arrived: bring the follow-up of its recommendation up to date. */
  async function refreshFollowUp(tenant: TenantId, preTradeId: string): Promise<boolean> {
    const rec = await q(db).selectFrom("recommendations").select(["recommendation_id", "follow_up"]).where("tenant_id", "=", tenant).where("pre_trade_id", "=", preTradeId).executeTakeFirst();
    if (!rec) return false;
    const pre = await c.preTrades.getPreTrade(tenant, preTradeId);
    const next = pre ? FOLLOW_UP[pre.status] : undefined;
    if (!next || next === rec.follow_up) return false;
    await q(db).updateTable("recommendations").set({ follow_up: next }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).execute();
    return true;
  }

  return { decide, onCycleClosed, refreshFollowUp };
}
