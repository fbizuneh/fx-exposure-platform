// Turn a finished run's net exposure into recommendations (decision 0011 items 2 to 8, 12, 17).
import { randomUUID } from "node:crypto";
import { asOfDate, type CycleId, type ProgramId, type TenantId } from "@shared/kernel";
import { lockCycleDecisions } from "./approval.ts";
import { D, addDays, addTenor, amountThresholdNeed, businessDaysBefore, calendarGaps, closedCurrencies, combineRoll, nextJointBusinessDay, finishRecommendation, fmt, noCalendar, pairKey, planRoll, ratioAdjustmentNeed, rollWithSpan, splitAmount, toBusinessCalendar, type BusinessCalendar, type MaturingLeg } from "./calc.ts";
import type { PartRole } from "../contract/index.ts";
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

    // The minimum and the maximum are set in the display currency; each exposure currency needs its own spot rate to turn them into that currency.
    const maxByLevel = new Map(policy.maxHedgeOverrides.map((o) => [o.nettingLevel, o.maxHedgeDisplay]));
    const byThreshold = policy.strategy === "amount-threshold";
    const thresholdByLevel = new Map(policy.amountThresholdOverrides.map((o) => [o.nettingLevel, o.amountThresholdDisplay]));
    const rateTo = new Map<string, string | null>();
    if (minDisplay.gt(0) || policy.maxHedgeDisplay !== null || maxByLevel.size > 0 || byThreshold) {
      for (const ccy of new Set(groups.map((g) => g.exposureCurrency))) {
        if (ccy === display) { rateTo.set(ccy, "1"); continue; }
        const r = await c.rates.getRate({ tenantId: tenant, base: ccy, quote: display, asOf: run!.asOf, tenor: "SPOT" });
        rateTo.set(ccy, r ? r.rate : null);
      }
    }
    const ratioFor = new Map(policy.ratioOverrides.map((o) => [pairKey(o.pair), o.ratio]));
    const roundingFor = new Map(policy.roundingOverrides.map((o) => [o.currency, o.rounding]));
    // Calendars are read as they stand today, not as of the cycle's as-of date: holidays are loaded ahead of time and a calendar loaded today is the best
    // knowledge there is for the dates being worked out (decision 0014). A currency without a calendar counts Saturdays and Sundays only, and the gap is recorded.
    const today = asOfDate(clock().toISOString().slice(0, 10));
    const loaded = new Map((await c.masterData.getCalendars(tenant, [...new Set(groups.flatMap((g) => [g.currency1, g.currency2]))], today)).map((x) => [x.currency, toBusinessCalendar(x)]));
    const calendarOf = (ccy: string): BusinessCalendar => loaded.get(ccy) ?? noCalendar(ccy);

    // The roll (decision 0021): each group's open hedge legs with their value dates and holding entity. The dates entered for the cycle are read below, under the cycle's lock.
    const rolling = policy.rollType === "ADJUST_SWAP";
    const legsOf = new Map<number, MaturingLeg[]>();
    if (rolling) {
      for (const h of await c.analysis.hedgeRows(tenant, event.runId)) {
        if (h.groupNo === null || h.valueDate === null || h.exposureAmount === null) continue;
        legsOf.set(h.groupNo, [...(legsOf.get(h.groupNo) ?? []), { valueDate: h.valueDate, entityCode: h.entityCode, exposureAmount: h.exposureAmount }]);
      }
    }

    return db.transaction().execute(async (tx) => {
      if (!(await firstTime(tx, tenant, event.eventId))) return "IGNORED";
      // The dates and the approval of the exposure take this lock, so these recommendations are made from dates that cannot change before the approval looks at them (review of PR 14).
      await lockCycleDecisions(tx, tenant, event.cycleId);
      // The dates this run finished with: the ones now in force, unless they were edited after the run finished, in which case the ones it finished with (review of PR 14).
      const bound = rolling ? await q(tx).selectFrom("roll_run_bindings").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("run_id", "=", event.runId).executeTakeFirst() : undefined;
      const current = rolling ? await q(tx).selectFrom("roll_parameters").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).executeTakeFirst() : undefined;
      const rollDates = bound ? (bound.near_date === null ? undefined : { near_date: bound.near_date, far_date: bound.far_date, offset_days: bound.offset_days, revision: bound.revision }) : current;
      const offsetDays = rollDates?.offset_days ?? policy.rollOffsetDays;
      await q(tx).updateTable("recommendations").set({ status: "SUPERSEDED" }).where("tenant_id", "=", tenant).where("cycle_id", "=", event.cycleId).where("status", "in", ["OPEN", "NONE"]).execute();
      const rows = [];
      const partRows: { tenant_id: string; recommendation_id: string; program_id: string; part_no: number; amount: string; trading_entity_code: string | null; role: PartRole; direction: "BUY" | "SELL" | null; value_date: string | null; fixing_date: string | null }[] = [];
      for (const g of groups) {
        const other = g.exposureCurrency === g.currency1 ? g.currency2 : g.currency1;
        const ratio = ratioFor.get(pairKey(g.currencyPair)) ?? policy.defaultRatio;
        const rounding = roundingFor.get(g.exposureCurrency) ?? policy.roundingDefault;
        const rate = rateTo.get(g.exposureCurrency);
        const minExposure = minDisplay.isZero() ? null : rate ? fmt(minDisplay.div(rate)) : null;
        const hedged = g.hedges.exposureAmount;
        // The maximum of one hedge (decision 0016): the level's own when it has one, else the program's, turned into the exposure currency.
        const maxDisplay = maxByLevel.get(g.nettingLevel) ?? policy.maxHedgeDisplay;
        const maxExposure = maxDisplay !== null && rate ? new D(fmt(new D(maxDisplay).div(rate))) : null;
        // The amount threshold (decision 0020): the level's own when it has one, else the program's, turned into the exposure currency.
        const thresholdDisplay = byThreshold ? thresholdByLevel.get(g.nettingLevel) ?? policy.amountThresholdDisplay : null;
        // The comparison uses the converted threshold as it is; rounding to four places is for what is stored and shown, and must not move a net across the threshold.
        const thresholdExact = thresholdDisplay !== null && rate ? new D(thresholdDisplay).div(rate) : null;
        // What the strategy wants, then the rules every strategy shares: rounding, the minimum and (below) the split.
        const need = byThreshold
          ? amountThresholdNeed({ netExposure: g.net.exposureAmount, hedgedAmount: hedged, thresholdExposure: thresholdExact === null ? null : thresholdExact.toFixed() })
          : ratioAdjustmentNeed({ grossExposure: g.gross.exposureAmount, hedgedAmount: hedged, ratio });
        const out = finishRecommendation(need, { rounding, minExposure, rateMissing: (minDisplay.gt(0) || maxDisplay !== null || thresholdDisplay !== null) && !rate });
        // The trade is booked by the group's entity when the netting level has one; otherwise by the policy's default trading entity (decision 0011 item 9).
        const tradingEntity = g.entityCode ?? policy.tradingEntityCode;
        const cals = [calendarOf(g.currency1), calendarOf(g.currency2)];
        const instrumentFor = ndf.has(g.exposureCurrency) ? "NDF" : "FORWARD";
        const tenorDate = rollWithSpan(addTenor(run!.asOf, policy.tenor), cals);
        const recommendationId = randomUUID();

        // The roll (decision 0021). Its far date is the one entered for the cycle, else the policy's tenor date for this group; the window must end before it. Without usable
        // dates a rolling program recommends nothing for the group.
        const farDate = rollDates?.far_date ? { date: rollDates.far_date, through: rollDates.far_date } : tenorDate;
        const rollUsable = rollDates !== undefined && farDate.date > addDays(rollDates.near_date, offsetDays);
        const datesMissing = rolling && !rollUsable;
        // An entered far date is used as entered, never moved for the user: if it is closed for a currency of the pair, the group waits for a new one (review of PR 14).
        const closed = rollUsable && rollDates!.far_date ? closedCurrencies(farDate.date, cals) : [];
        const rollIssue = closed.length > 0 ? { date: farDate.date, closedCurrencies: closed, suggestedDate: nextJointBusinessDay(farDate.date, cals) } : null;
        const roll = rollUsable && rollIssue === null ? planRoll(legsOf.get(g.groupNo) ?? [], rollDates!.near_date, offsetDays) : null;
        const adjustment = out.action === "HEDGE" ? { direction: out.direction!, amount: out.amount! } : null;
        const fixingOf = (date: string): string | null => (instrumentFor === "NDF" ? businessDaysBefore(date, 2, cals) : null);

        // The trades, in the order they are numbered: close-outs by value date, then the roll, then the adjustment (split if it is above the maximum).
        const trades: { role: PartRole; tradingEntity: string | null; amount: InstanceType<typeof D>; direction: "BUY" | "SELL" | null; valueDate: string | null; fixingDate: string | null }[] = [];
        let direction = out.direction, amountOut = out.amount;
        let split: ReturnType<typeof splitAmount> | null = null;
        if (roll) {
          for (const x of roll.closeOuts) trades.push({ role: "CLOSE_OUT", tradingEntity: x.entityCode, amount: x.amount, direction: x.direction, valueDate: x.valueDate, fixingDate: fixingOf(x.valueDate) });
          if (policy.rollAdjustment === "COMBINED") {
            const far = combineRoll(roll.maturing, adjustment);
            if (far) trades.push({ role: "COMBINED", tradingEntity: tradingEntity, amount: far.amount, direction: null, valueDate: null, fixingDate: null });
            direction = far?.direction ?? null; amountOut = far?.amount ?? null;
          } else if (roll.roll) {
            trades.push({ role: "ROLL", tradingEntity: tradingEntity, amount: roll.roll.amount, direction: roll.roll.direction, valueDate: farDate.date, fixingDate: fixingOf(farDate.date) });
          }
        }
        if (adjustment && (!roll || policy.rollAdjustment === "SEPARATE")) {
          split = splitAmount(adjustment.amount, maxExposure, policy.splitMethod, new D(rounding), minExposure === null ? null : new D(minExposure));
          for (const part of split.parts) trades.push({ role: "ADJUSTMENT", tradingEntity: tradingEntity, amount: part, direction: null, valueDate: null, fixingDate: null });
        }
        // A close-out is booked by the entity holding the hedge; the far trades need the group's own or the policy's default entity.
        const noEntity = tradingEntity === null && trades.some((x) => x.role !== "CLOSE_OUT");
        const action = datesMissing || rollIssue !== null || noEntity || trades.length === 0 ? "NONE" : "HEDGE";
        const reason = datesMissing ? "ROLL_DATES_NOT_SET" : rollIssue !== null ? "FAR_DATE_CLOSED" : noEntity ? "NO_TRADING_ENTITY" : adjustment === null || (roll && policy.rollAdjustment === "COMBINED" && amountOut === null) ? out.reason : null;
        const instrument = action === "HEDGE" ? instrumentFor : null;
        const valueDate = action !== "HEDGE" ? null : roll ? farDate.date : tenorDate.date;
        if (action === "HEDGE") trades.forEach((x, i) => partRows.push({ tenant_id: tenant, recommendation_id: recommendationId, program_id: event.programId, part_no: i + 1, amount: fmt(x.amount), trading_entity_code: x.role === "CLOSE_OUT" ? x.tradingEntity : null, role: x.role, direction: x.direction, value_date: x.valueDate, fixing_date: x.fixingDate }));
        rows.push({
          tenant_id: tenant, recommendation_id: recommendationId, program_id: event.programId, cycle_id: event.cycleId, run_id: event.runId, strategy: policy.strategy,
          group_no: g.groupNo, netting_level: g.nettingLevel, region: g.region, entity_code: g.entityCode, currency_pair: g.currencyPair, exposure_currency: g.exposureCurrency, other_currency: other,
          gross_exposure: g.gross.exposureAmount, hedged_amount: hedged, ratio: byThreshold ? null : ratio, threshold_exposure_amount: byThreshold && thresholdExact !== null ? fmt(thresholdExact) : null, target_hedge: fmt(out.target), needed_amount: fmt(out.needed), rounding, min_exposure_amount: minExposure,
          trading_entity_code: tradingEntity, action, reason, direction: action !== "HEDGE" ? null : direction, amount: action !== "HEDGE" || amountOut === null ? null : fmt(amountOut), instrument,
          value_date: valueDate, fixing_date: instrument === "NDF" && valueDate !== null ? businessDaysBefore(valueDate, 2, cals) : null,
          calendar_gaps: JSON.stringify(action !== "HEDGE" ? [] : calendarGaps(cals, roll ? farDate.through : tenorDate.through)),
          roll_type: rollUsable ? "ADJUST_SWAP" : null, roll_adjustment: rollUsable ? policy.rollAdjustment : null, roll_near_date: rollUsable ? rollDates!.near_date : null,
          roll_far_date: rollUsable ? farDate.date : null, roll_offset_days: rollUsable ? offsetDays : null,
          roll_revision: rolling ? rollDates?.revision ?? null : null, roll_issue: rollIssue === null ? null : JSON.stringify(rollIssue),
          max_exposure_amount: action === "HEDGE" && split && maxExposure ? fmt(maxExposure) : null, split_method: action === "HEDGE" && split && maxExposure ? policy.splitMethod : null, split_note: action === "HEDGE" ? split?.note ?? null : null,
          status: action === "HEDGE" ? "OPEN" : "NONE", created_at: clock(),
        });
      }
      for (let i = 0; i < rows.length; i += 200) await q(tx).insertInto("recommendations").values(rows.slice(i, i + 200)).execute();
      for (let i = 0; i < partRows.length; i += 200) await q(tx).insertInto("recommendation_parts").values(partRows.slice(i, i + 200)).execute();
      await announce(tx, { type: "hedge-recommendation.recommendations-issued", tenantId: tenant, cycleId: event.cycleId, programId: event.programId, runId: event.runId });
      return "ISSUED";
    });
  }

  return { onRunFinished };
}
