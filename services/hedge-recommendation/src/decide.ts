// Decisions on recommendations, and follow-up from FX Trade (decision 0011 items 10, 11, 13).
import type { TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import type { FollowUp, Recommendation } from "../contract/index.ts";
import { require_, who } from "./access.ts";
import { q, type Db } from "./db.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { readPolicy, toRecommendation } from "./queries.ts";

export class RecommendationError extends Error {}

export type Decision = "ACCEPT" | "OVERRIDE" | "DISMISS";
const PERMISSION = { ACCEPT: "hedge-recommendation:accept", OVERRIDE: "hedge-recommendation:override", DISMISS: "hedge-recommendation:dismiss" } as const;
const FOLLOW_UP: Record<string, FollowUp> = { DRAFT: "OPEN", READY: "OPEN", SENT: "OPEN", PARTLY_EXECUTED: "PARTLY_EXECUTED", EXECUTED: "EXECUTED", CANCELLED: "CANCELLED" };

export function decideCommands(db: Db, c: Collaborators, clock: () => Date) {
  async function decide(input: { tenantId: TenantId; recommendationId: string; actor: Actor; action: Decision; amount?: string; note?: string }): Promise<Recommendation> {
    const { tenantId: tenant } = input;
    const rec = await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", input.recommendationId).executeTakeFirst();
    if (!rec) throw new RecommendationError(`recommendation ${input.recommendationId} does not exist`);
    await require_(c.access, tenant, input.actor, PERMISSION[input.action], rec.program_id as never);
    if (rec.action !== "HEDGE" || rec.status !== "OPEN") throw new RecommendationError(`the recommendation is ${rec.status.toLowerCase()} and cannot be decided`);
    const cycle = await c.management.getCycle(tenant, rec.cycle_id as never);
    if (!cycle || cycle.approvedAt !== null || cycle.outcome !== null) throw new RecommendationError("the cycle is approved or closed; recommendations can no longer be decided");
    const by = who(input.actor);
    const note = input.note ?? null;

    if (input.action === "DISMISS") {
      await q(db).updateTable("recommendations").set({ status: "DISMISSED", decided_by: by, decided_at: clock(), decision_note: note }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").execute();
      return reread(tenant, rec.recommendation_id);
    }

    let amount = rec.amount!;
    if (input.action === "OVERRIDE") {
      if (input.amount === undefined || !/^\d+(\.\d{1,4})?$/.test(input.amount) || Number(input.amount) <= 0) throw new RecommendationError("an override needs a positive amount with up to 4 decimals");
      amount = input.amount;
    }
    const policy = await readPolicy(db, tenant, rec.program_id as never);
    if (policy.tradingEntityCode === null) throw new RecommendationError("set the trading entity in the hedge policy before accepting recommendations");

    // FX Trade first: it is safe to repeat (keyed by the recommendation ID), and a refusal leaves the recommendation open.
    const [made] = await c.createPreTrades({
      tenantId: tenant, cycleId: rec.cycle_id as never, by,
      items: [{
        recommendationId: rec.recommendation_id, tradingEntityCode: policy.tradingEntityCode, instrument: rec.instrument as "FORWARD" | "NDF",
        legs: [{ role: "SINGLE", direction: rec.direction as "BUY" | "SELL", dealCurrency: rec.exposure_currency, dealAmount: amount, settlementCurrency: rec.other_currency, settlementAmount: null, valueDate: rec.value_date!, fixingDate: rec.fixing_date }],
      }],
    });
    if (!made) throw new RecommendationError("FX Trade did not return a pre-trade");

    await db.transaction().execute(async (tx) => {
      const r = await q(tx).updateTable("recommendations").set({
        status: input.action === "OVERRIDE" ? "OVERRIDDEN" : "ACCEPTED", decided_amount: amount, decided_by: by, decided_at: clock(), decision_note: note, pre_trade_id: made.preTradeId, follow_up: "OPEN",
      }).where("tenant_id", "=", tenant).where("recommendation_id", "=", rec.recommendation_id).where("status", "=", "OPEN").executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new RecommendationError("the recommendation was decided by someone else first");
      await announce(tx, { type: "hedge-recommendation.pre-trade-created", tenantId: tenant, recommendationId: rec.recommendation_id, preTradeId: made.preTradeId, cycleId: rec.cycle_id as never, programId: rec.program_id as never });
    });
    return reread(tenant, rec.recommendation_id);
  }

  async function reread(tenant: TenantId, id: string): Promise<Recommendation> {
    return toRecommendation((await q(db).selectFrom("recommendations").selectAll().where("tenant_id", "=", tenant).where("recommendation_id", "=", id).executeTakeFirstOrThrow()));
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

  return { decide, refreshFollowUp };
}
