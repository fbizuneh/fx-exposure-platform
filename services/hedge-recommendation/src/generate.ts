// Turn a finished run's net exposure into recommendations (decision 0011 items 2 to 8, 12, 17).
import { randomUUID } from "node:crypto";
import type { CycleId, ProgramId, TenantId } from "@shared/kernel";
import { D, fmt, pairKey, recommend, valueDateFor, weekdaysBefore } from "./calc.ts";
import { firstTime } from "./events.ts";
import { q, type Db } from "./db.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { readPolicy } from "./queries.ts";

export interface RunFinishedEvent { readonly eventId: string; readonly tenantId: TenantId; readonly cycleId: CycleId; readonly programId: ProgramId; readonly runId: string }


export function generateCommands(db: Db, c: Collaborators, clock: () => Date) {
  /** For a "run finished" event: replaces the cycle's undecided recommendations with ones from this run. */
  async function onRunFinished(event: RunFinishedEvent): Promise<"ISSUED" | "IGNORED"> {
    const { tenantId: tenant } = event;
    const cycle = await c.management.getCycle(tenant, event.cycleId);
    const run = await c.analysis.currentRun(tenant, event.cycleId);
    let stale = !cycle || cycle.approvedAt !== null || cycle.outcome !== null || !run || run.runId !== event.runId || run.status !== "FINISHED";
    // Once the exposure is approved the cycle is never recalculated, so nothing may replace its recommendations. The one thing still allowed is
    // making them for the approved run itself, when its "run finished" event reached us after the approval. Only that run's own recommendations
    // count as "already made"; an earlier run's preview rows must not block it (they are superseded below).
    if (!stale && cycle!.exposureApprovedAt !== null) {
      const have = await q(db).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("run_id", "=", event.runId).limit(1).executeTakeFirst();
      stale = cycle!.exposureApprovedRunId !== event.runId || have !== undefined;
    }
    if (stale) {
      await db.transaction().execute((tx) => firstTime(tx, tenant, event.eventId));
      return "IGNORED";
    }
    const groups = await c.analysis.netExposures(tenant, event.runId);
    const policy = await readPolicy(db, tenant, event.programId);
    const ndf = new Set((await c.masterData.getCurrencies(tenant, run!.asOf)).filter((x) => x.isNdf).map((x) => x.code));
    const display = run!.displayCurrency;
    const minDisplay = new D(policy.minHedgeDisplay);

    // The minimum is set in the display currency; each exposure currency needs its own spot rate to turn it into that currency.
    const rateTo = new Map<string, string | null>();
    if (minDisplay.gt(0)) {
      for (const ccy of new Set(groups.map((g) => g.exposureCurrency))) {
        if (ccy === display) { rateTo.set(ccy, "1"); continue; }
        const r = await c.rates.getRate({ tenantId: tenant, base: ccy, quote: display, asOf: run!.asOf, tenor: "SPOT" });
        rateTo.set(ccy, r ? r.rate : null);
      }
    }
    const ratioFor = new Map(policy.ratioOverrides.map((o) => [pairKey(o.pair), o.ratio]));
    const roundingFor = new Map(policy.roundingOverrides.map((o) => [o.currency, o.rounding]));
    const valueDate = valueDateFor(run!.asOf, policy.tenor);

    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, tenant, event.eventId))) return "IGNORED";
      await q(tx).updateTable("recommendations").set({ status: "SUPERSEDED" }).where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "in", ["OPEN", "NONE"]).execute();
      const rows = [];
      for (const g of groups) {
        const other = g.exposureCurrency === g.currency1 ? g.currency2 : g.currency1;
        const ratio = ratioFor.get(pairKey(g.currencyPair)) ?? policy.defaultRatio;
        const rounding = roundingFor.get(g.exposureCurrency) ?? policy.roundingDefault;
        const rate = rateTo.get(g.exposureCurrency);
        const minExposure = minDisplay.isZero() ? null : rate ? fmt(minDisplay.div(rate)) : null;
        const hedged = g.hedges.exposureAmount;
        const out = recommend({ grossExposure: g.gross.exposureAmount, hedgedAmount: hedged, ratio, rounding, minExposure, rateMissing: minDisplay.gt(0) && !rate });
        // The trade is booked by the group's entity when the netting level has one; otherwise by the policy's default trading entity (decision 0011 item 9).
        const tradingEntity = g.entityCode ?? policy.tradingEntityCode;
        const noEntity = out.action === "HEDGE" && tradingEntity === null;
        const action = noEntity ? "NONE" : out.action;
        const instrument = action === "HEDGE" ? (ndf.has(g.exposureCurrency) ? "NDF" : "FORWARD") : null;
        rows.push({
          tenant_id: tenant, recommendation_id: randomUUID(), program_id: event.programId, cycle_id: event.cycleId, run_id: event.runId, strategy: "hedge-ratio-adjustment",
          group_no: g.groupNo, netting_level: g.nettingLevel, region: g.region, entity_code: g.entityCode, currency_pair: g.currencyPair, exposure_currency: g.exposureCurrency, other_currency: other,
          gross_exposure: g.gross.exposureAmount, hedged_amount: hedged, ratio, target_hedge: fmt(out.target), needed_amount: fmt(out.needed), rounding, min_exposure_amount: minExposure,
          trading_entity_code: tradingEntity, action, reason: noEntity ? "NO_TRADING_ENTITY" : out.reason, direction: noEntity ? null : out.direction,
          amount: out.amount === null || noEntity ? null : fmt(out.amount), instrument,
          value_date: action === "HEDGE" ? valueDate : null, fixing_date: instrument === "NDF" ? weekdaysBefore(valueDate, 2) : null,
          status: action === "HEDGE" ? "OPEN" : "NONE", created_at: clock(),
        });
      }
      for (let i = 0; i < rows.length; i += 200) await q(tx).insertInto("recommendations").values(rows.slice(i, i + 200)).execute();
      await announce(tx, { type: "hedge-recommendation.recommendations-issued", tenantId: tenant, cycleId: event.cycleId, programId: event.programId, runId: event.runId });
      return "ISSUED";
    });
  }

  return { onRunFinished };
}
