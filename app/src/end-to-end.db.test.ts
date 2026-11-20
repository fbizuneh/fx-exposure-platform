// One cycle across the real services: no fakes. They share a database server, each in its own schema, and
// the dispatcher in app/ carries the announcements between them. Needs TEST_DATABASE_URL (name ends in _test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { asOfDate, programId, type TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { migrate } from "../../scripts/migrate.mjs";
import { composeApp, type App } from "./compose.ts";
import { NO_ACTION_MESSAGES } from "../../services/hedge-recommendation/contract/index.ts";
import { sql, type KyselyPlugin } from "kysely";
import { connect as connectHr, createHedgeRecommendation } from "../../services/hedge-recommendation/src/index.ts";
import { connect as connectEm, createExposureManagement } from "../../services/exposure-management/src/index.ts";
import { readPolicy } from "../../services/hedge-recommendation/src/queries.ts";
import { parseExecutedFile } from "../../services/fx-trade/src/index.ts";
import { RETRY_POLICY, deliveryProblems, drain, retryStuckEvent, startDueCycles } from "./dispatch.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("end-to-end database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const e2e = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

const clock = { now: new Date("2026-11-09T23:00:00Z") };
let app: App;

before(async () => {
  if (!enabled) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade"]) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await client.end();
  await migrate(url!);
  app = composeApp(url!, () => clock.now);
});
after(async () => {
  if (enabled) await app.close();
});

const D0 = asOfDate("2026-01-01");
const entity = (code: string, over: object = {}) => ({ code, name: code, type: "BUSINESS_UNIT", parentCode: null, countryCode: null, functionalCurrency: null, isLegalEntity: false, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over });
const legal = (code: string, currency: string, parentCode: string) => entity(code, { type: "LEGAL_ENTITY", isLegalEntity: true, functionalCurrency: currency, parentCode, countryCode: "US", isHedgeExecutionEntity: code === "US01" });
const spot = (base: string, quote: string, allIn: string) => ({ base, quote, type: "SPOT" as const, tenor: "SPOT", valueDate: null, allIn, spot: null, forwardPoints: null, bid: null, mid: null, ask: null, observedAt: clock.now.toISOString() });
const row = (entityCode: string, currency: string, balance: string) => ({ entityCode, accountNumber: "4000", currency, balance, debit: null, credit: null, asOf: null, dimensions: {} });

const admins = new Map<TenantId, Actor>();
/** The two gates, in order: Approve Exposure locks the run, Approve Cycle releases pre-trades. */
async function approveExposure(t: TenantId, cycle: string): Promise<void> {
  await app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle, actor: admins.get(t)! });
  await drain(app);
}
async function tenantWithProgram(level = "ENTITY", segregation = false): Promise<TenantId> {
  const t = await app.identity.commands.createTenant("Acme");
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  await app.identity.commands.enableProgram(t, programId("BS"), ops);
  const adminId = await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ADMIN"] }, ops);
  admins.set(t, { kind: "user", userId: adminId });
  await app.exposureManagement.commands.defineProgram({
    tenantId: t, programId: "BS", name: "Daily balance sheet", type: "BALANCE_SHEET", effectiveFrom: "2026-01-01", actor: admins.get(t)!,
    settings: { nettingLevel: level, bucketScheme: { kind: "MONTHS" }, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } },
  });
  // Segregation of duties is on for every tenant unless switched off; these tests run a whole cycle as one admin, so they switch it off (the tests for the rule switch it on).
  if (!segregation) await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: admins.get(t)! });
  const md = (kind: "applyEntities" | "applyHierarchy" | "applyAccounts" | "applyCurrencies", rows: unknown[]) =>
    app.masterData.commands[kind]({ tenantId: t, sourceSystem: "erp", asOf: D0, mode: "SNAPSHOT", rows: rows as never, by: "test" });
  await md("applyEntities", [entity("G"), entity("AMER", { type: "REGION", parentCode: "G" }), entity("EMEA", { type: "REGION", parentCode: "G" }), legal("US01", "USD", "AMER"), legal("DE01", "EUR", "EMEA")]);
  await md("applyHierarchy", [{ chartCode: "C", code: "1", name: "Assets", classification: "ASSETS", parentCode: null }]);
  await md("applyAccounts", [{ chartCode: "C", accountNumber: "4000", name: "Receivables", statementType: "BALANCE_SHEET", normalBalance: "DEBIT", monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode: "1" }]);
  await md("applyCurrencies", [{ code: "EUR", isNdf: false }]);
  await drain(app); // enabled and defined: Data Source learns the program from the announcement
  await app.dataSource.commands.addMappingRule({ tenantId: t, programId: "BS", kind: "INCLUDE", target: { type: "NODE", chartCode: "C", nodeCode: "1" }, validFrom: "2026-01-01", validTo: null, by: "test" });
  return t;
}
const sendBalances = (t: TenantId, asOf: string) =>
  app.dataSource.commands.submitGlBatch({ tenantId: t, sourceSystem: "erp", chartCode: "C", asOf: asOfDate(asOf), rows: [row("US01", "EUR", "1000"), row("DE01", "USD", "550"), row("US01", "USD", "70")], by: "test" });
const sendRates = (t: TenantId, date: string, eurUsd: string) =>
  app.fxRate.commands.loadRates({ tenantId: t, source: "bank", businessDate: asOfDate(date), rows: [spot("EUR", "USD", eurUsd)], by: "test" });

e2e("a scheduled cycle runs from balances and rates to a completed, approved, frozen record", async () => {
  const t = await tenantWithProgram();
  assert.deepEqual((await app.dataSource.questions.ingestionStatus(t, {})).length, 0);
  assert.equal((await app.exposureManagement.questions.programCatalog(t))[0]?.enabled, true);

  await sendRates(t, "2026-11-09", "1.1");
  const batch = await sendBalances(t, "2026-11-09");
  assert.deepEqual([batch.received, batch.included, batch.blocked], [3, 3, 0]);
  await drain(app);

  const [cycle] = await startDueCycles(app, t, "2026-11-10", admins.get(t)!);
  assert.ok(cycle);
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle as never))?.stage, "INITIATED");
  await drain(app);

  const done = (await app.exposureManagement.questions.getCycle(t, cycle as never))!;
  assert.equal(done.stage, "COMPLETED", "run started and run finished moved the cycle on");
  const run = (await app.exposureAnalysis.questions.currentRun(t, cycle as never))!;
  assert.deepEqual([run.status, run.waitReason, run.nettingLevel, run.displayCurrency], ["FINISHED", null, "ENTITY", "USD"]);
  const groups = await app.exposureAnalysis.questions.exposures(t, run.runId);
  assert.deepEqual(groups.map((g) => `${g.entityCode}:${g.currencyPair}:${g.net1}:${g.exposureCurrency}`), ["DE01:EUR-USD:-500.00:USD", "US01:EUR-USD:1000.00:EUR"]);
  const drill = await app.exposureAnalysis.questions.drilldown(t, run.runId, groups[1]!.groupNo);
  assert.equal(drill[0]?.lineage.batchId, batch.batchId, "a number traces back to the batch Data Source stored");

  await approveExposure(t, cycle as string);
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admins.get(t)! });
  await drain(app);
  assert.ok((await app.exposureAnalysis.questions.currentRun(t, cycle as never))?.frozenAt, "approval froze the run");
  assert.equal(await drain(app), 0, "nothing is left to deliver, and delivering again would change nothing");
});

e2e("a cycle with no data waits, blocks the next one, and finishes by itself when the balances and rates arrive", async () => {
  const t = await tenantWithProgram();
  clock.now = new Date("2026-11-10T23:00:00Z");
  const [cycle] = await startDueCycles(app, t, "2026-11-11", admins.get(t)!);
  await drain(app);
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle as never))?.stage, "INITIATED");
  const waiting = (await app.exposureAnalysis.questions.currentRun(t, cycle as never))!;
  assert.deepEqual([waiting.status, /No included balances/.test(waiting.waitReason ?? "")], ["WAITING", true]);
  assert.deepEqual(await startDueCycles(app, t, "2026-11-11", admins.get(t)!), [], "an open cycle holds back the next one");

  await sendBalances(t, "2026-11-10");
  await drain(app);
  assert.match((await app.exposureAnalysis.questions.currentRun(t, cycle as never))!.waitReason ?? "", /Missing spot rates/, "balances arrived; the rate is still missing");
  await sendRates(t, "2026-11-10", "1.2");
  await drain(app);
  const run = (await app.exposureAnalysis.questions.currentRun(t, cycle as never))!;
  assert.equal(run.status, "FINISHED");
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle as never))?.stage, "COMPLETED");
});

e2e("approval releases a recommended pre-trade; a simulated platform returns the file; the executed trade matches and the cycle record is untouched", async () => {
  clock.now = new Date("2026-11-11T23:00:00Z");
  const t = await tenantWithProgram();
  await sendRates(t, "2026-11-11", "1.1");
  await sendBalances(t, "2026-11-11");
  await drain(app);
  const [cycle] = await startDueCycles(app, t, "2026-11-12", admins.get(t)!);
  await drain(app);
  const before = (await app.exposureAnalysis.questions.currentRun(t, cycle as never))!;
  assert.equal(before.status, "FINISHED");

  // Hedge Recommendation would call this; it does not exist yet, so the test plays its part.
  const [made] = await app.fxTrade.commands.createPreTrades({
    tenantId: t, cycleId: cycle as never, by: "recommendation",
    items: [{ recommendationId: "rec-1", tradingEntityCode: "US01", instrument: "FORWARD", legs: [{ role: "SINGLE", direction: "SELL", dealCurrency: "EUR", dealAmount: "1000", settlementCurrency: "USD", settlementAmount: null, valueDate: "2026-12-15", fixingDate: null }] }],
  });
  await drain(app);
  assert.equal((await app.fxTrade.questions.getPreTrade(t, made!.preTradeId))!.status, "DRAFT", "nothing goes out before approval");

  await approveExposure(t, cycle as string);
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admins.get(t)! });
  await drain(app);
  assert.equal((await app.fxTrade.questions.getPreTrade(t, made!.preTradeId))!.status, "READY", "approval released it");

  const sent = await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admins.get(t)! });
  assert.equal(sent.preTradeIds.length, 1);
  // The simulator: reads the outbound file and answers in the standard executed-trade file, echoing the reference.
  const [h, d] = sent.file.trim().split("\n").map((l) => l.split(","));
  const out = Object.fromEntries(h!.map((k, i) => [k, d![i]!]));
  const reply = [
    "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference",
    `SIM-1,SIMFX,${out.trading_entity},Sim Bank,2026-11-12,${out.value_date},${out.deal_currency},${out.deal_amount},${out.settlement_currency},1105.0000,${out.instrument},${out.buy_sell},${out.hedging_program_id},${out.pre_trade_reference}`,
  ].join("\n");
  const r = await app.fxTrade.commands.importExecutedTrades({ tenantId: t, rows: parseExecutedFile(reply), by: "simulator" });
  assert.deepEqual([r.stored, r.matched, r.blocked], [1, 1, 0]);
  await drain(app);

  assert.equal((await app.fxTrade.questions.getPreTrade(t, made!.preTradeId))!.status, "EXECUTED");
  const open = await app.fxTrade.questions.executedTrades(t, { programId: programId("BS"), asOf: asOfDate("2026-11-12") });
  assert.deepEqual(open.map((x) => [x.tradeId, x.legs[0]!.dealAmount, x.preTradeId]), [["SIM-1", "1000.0000", made!.preTradeId]]);
  const after = (await app.exposureAnalysis.questions.currentRun(t, cycle as never))!;
  assert.deepEqual([after.runId, after.status, after.frozenAt !== null], [before.runId, "FINISHED", true], "a trade arriving after approval leaves the saved run alone");
  assert.equal(await drain(app), 0);

  // The next day's cycle counts that trade as an outstanding hedge: net exposure is gross less the 1000 EUR sold forward.
  clock.now = new Date("2026-11-12T23:00:00Z");
  await sendRates(t, "2026-11-12", "1.1");
  await sendBalances(t, "2026-11-12");
  await drain(app);
  const [next] = await startDueCycles(app, t, "2026-11-13", admins.get(t)!);
  await drain(app);
  const run2 = (await app.exposureAnalysis.questions.currentRun(t, next as never))!;
  assert.equal(run2.status, "FINISHED");
  assert.deepEqual(run2.hedgeCounts, { trades: 1, openLegs: 1, used: 1, noEntity: 0, excluded: [] });
  const all = await app.exposureAnalysis.questions.netExposures(t, run2.runId);
  const eur = all.find((g) => g.currencyPair === "EUR-USD" && g.entityCode === "US01")!;
  assert.equal(eur.hedges.exposureAmount, "-1000.00");
  assert.deepEqual([eur.gross.exposureAmount, eur.net.exposureAmount], ["1000.00", "0.00"]);
});

/** A tenant whose cycle for the 12th has finished its run, with the recommendations it produced. */
async function finishedCycle(policy?: object, level = "ENTITY", approve = true, segregation = false, before?: (t: TenantId) => Promise<unknown>, eurUsd = "1.1") {
  clock.now = new Date("2026-11-11T23:00:00Z");
  const t = await tenantWithProgram(level, segregation);
  const admin = admins.get(t)!;
  if (policy) await app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: admin, policy: policy as never });
  if (before) await before(t);
  await sendRates(t, "2026-11-11", eurUsd);
  await sendBalances(t, "2026-11-11");
  await drain(app);
  const [cycle] = await startDueCycles(app, t, "2026-11-12", admin);
  await drain(app);
  const recs = await app.hedgeRecommendation.questions.recommendations(t, cycle as never);
  if (approve) await approveExposure(t, cycle as string);
  return { t, admin, cycle: cycle as never, recs };
}
const defaults = { defaultRatio: "1", ratioOverrides: [], minHedgeDisplay: "0", roundingDefault: "1000", roundingOverrides: [], tenor: "1M", tradingEntityCode: "US01" };

e2e("a finished run produces recommendations; accepting one makes a draft pre-trade, approval releases it, and the follow-up status follows the executed trade", async () => {
  const { t, admin, cycle, recs } = await finishedCycle();
  const act = recs.filter((r) => r.action === "HEDGE");
  assert.deepEqual(act.map((r) => [r.entityCode, r.currencyPair, r.exposureCurrency, r.direction, r.amount, r.status, r.instrument]), [["US01", "EUR-USD", "EUR", "SELL", "1000.00", "OPEN", "FORWARD"]]);
  assert.equal(recs.find((r) => r.entityCode === "DE01")!.reason, "ROUNDS_TO_ZERO", "550 USD against a rounding of 1,000 gives nothing to trade");
  assert.ok(act[0]!.valueDate! > "2026-11-12" && ![0, 6].includes(new Date(`${act[0]!.valueDate}T00:00:00Z`).getUTCDay()), "a weekday after the as-of date");

  assert.deepEqual([act[0]!.tradingEntityCode, recs.find((r) => r.entityCode === "DE01")!.tradingEntityCode], ["US01", "DE01"], "at entity level each group is booked by its own entity; no policy is needed");
  const accepted = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: act[0]!.recommendationId, actor: admin, action: "ACCEPT", note: "ok" });
  assert.deepEqual([accepted.status, accepted.decidedAmount, accepted.followUp, accepted.decisionNote], ["ACCEPTED", "1000.00", "OPEN", "ok"]);
  assert.ok(accepted.decidedBy!.startsWith("user:") && accepted.decidedAt !== null);
  const pre = (await app.fxTrade.questions.getPreTrade(t, accepted.preTradeId!))!;
  assert.deepEqual([pre.status, pre.legs[0]!.direction, pre.legs[0]!.dealCurrency, pre.legs[0]!.dealAmount, pre.legs[0]!.settlementCurrency], ["DRAFT", "SELL", "EUR", "1000.0000", "USD"]);
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: act[0]!.recommendationId, actor: admin, action: "DISMISS" }), /cannot be decided/);

  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle, actor: admin });
  await drain(app);
  assert.equal((await app.fxTrade.questions.getPreTrade(t, accepted.preTradeId!))!.status, "READY");
  const after = await app.hedgeRecommendation.questions.recommendations(t, cycle);
  assert.ok(after.every((r) => r.status !== "OPEN"), "nothing is left open once the cycle is approved");

  const sent = await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin });
  const [h, d] = sent.file.trim().split("\n").map((l) => l.split(","));
  const out = Object.fromEntries(h!.map((k, i) => [k, d![i]!]));
  const reply = [
    "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference",
    `SIM-9,SIMFX,${out.trading_entity},Sim Bank,2026-11-12,${out.value_date},${out.deal_currency},${out.deal_amount},${out.settlement_currency},1105.0000,${out.instrument},${out.buy_sell},${out.hedging_program_id},${out.pre_trade_reference}`,
  ].join("\n");
  await app.fxTrade.commands.importExecutedTrades({ tenantId: t, rows: parseExecutedFile(reply), by: "simulator" });
  await drain(app);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, accepted.recommendationId))!.followUp, "EXECUTED");

  // The next cycle counts the executed hedge in the entity group it was booked for, so that group is already at target.
  clock.now = new Date("2026-11-12T23:00:00Z");
  await sendRates(t, "2026-11-12", "1.1");
  await sendBalances(t, "2026-11-12");
  await drain(app);
  const [next] = await startDueCycles(app, t, "2026-11-13", admin);
  await drain(app);
  const us = (await app.hedgeRecommendation.questions.recommendations(t, next as never)).find((r) => r.entityCode === "US01" && r.currencyPair === "EUR-USD")!;
  assert.deepEqual([us.hedgedAmount, us.action, us.reason], ["-1000.00", "NONE", "WITHIN_TARGET"]);

  // The amount-threshold strategy decides on the net exposure after that hedge (zero), not the gross 1,000 EUR, which is above a 100 USD threshold.
  await app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: admin, policy: { ...defaults, strategy: "amount-threshold", amountThresholdDisplay: "100" } as never });
  await app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: next, actor: admin } as never);
  await drain(app);
  const byAmount = (await app.hedgeRecommendation.questions.recommendations(t, next as never)).find((r) => r.entityCode === "US01" && r.currencyPair === "EUR-USD")!;
  assert.deepEqual([byAmount.strategy, byAmount.grossExposure, byAmount.hedgedAmount, byAmount.action, byAmount.reason], ["amount-threshold", "1000.00", "-1000.00", "NONE", "WITHIN_THRESHOLD"]);
});

e2e("the policy shapes the recommendation: ratio override, rounding override, and a minimum set in the display currency and tested in the exposure currency", async () => {
  const policy = { ...defaults, ratioOverrides: [{ pair: "EUR-USD", ratio: "0.5" }], roundingOverrides: [{ currency: "EUR", rounding: "100" }] };
  // 1,000 EUR at 50% is 500, rounded to 100s: 500. A 600 USD minimum is about 545.45 EUR at 1.1, so 500 is below it.
  const below = await finishedCycle({ ...policy, minHedgeDisplay: "600" });
  const b = below.recs.find((r) => r.entityCode === "US01")!;
  assert.deepEqual([b.action, b.reason, b.neededAmount, b.minExposureAmount, b.ratio, b.rounding], ["NONE", "BELOW_MINIMUM", "-500.00", "545.4545", "0.5", "100.00"]);
  // A 500 USD minimum is about 454.55 EUR: 500 passes.
  const above = await finishedCycle({ ...policy, minHedgeDisplay: "500" });
  const a = above.recs.find((r) => r.entityCode === "US01")!;
  assert.deepEqual([a.action, a.direction, a.amount, a.status], ["HEDGE", "SELL", "500.00", "OPEN"]);
  // An override changes the amount, not the direction; a dismissal needs no pre-trade.
  const o = await app.hedgeRecommendation.commands.decide({ tenantId: above.t, recommendationId: a.recommendationId, actor: above.admin, action: "OVERRIDE", amount: "300" });
  assert.deepEqual([o.status, o.decidedAmount, o.direction, o.amount], ["OVERRIDDEN", "300.00", "SELL", "500.00"]);
  const pre = (await app.fxTrade.questions.getPreTrade(above.t, o.preTradeId!))!;
  assert.equal(pre.legs[0]!.dealAmount, "300.0000");
});

e2e("before Approve Exposure recommendations are a preview: nothing can be decided or make a pre-trade, recalculating replaces them, and a stale one can never be decided", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults, "ENTITY", false);
  const r1 = recs.find((r) => r.action === "HEDGE")!;
  for (const decision of [{ action: "ACCEPT" }, { action: "OVERRIDE", amount: "300" }, { action: "DISMISS" }] as const) {
    await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: r1.recommendationId, actor: admin, ...decision }), /exposure has not been approved/);
  }
  assert.deepEqual(await app.fxTrade.questions.preTrades(t, { cycleId: cycle }), [], "no pre-trade exists before the exposure is approved");
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, r1.recommendationId))!.status, "OPEN");

  // Recalculating before approval is allowed and replaces the preview.
  await app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: cycle, actor: admin } as never);
  await drain(app);
  const now = await app.hedgeRecommendation.questions.recommendations(t, cycle);
  const r2 = now.find((r) => r.action === "HEDGE")!;
  assert.notEqual(r2.recommendationId, r1.recommendationId);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, r1.recommendationId))!.status, "SUPERSEDED");
  assert.equal(now.filter((r) => r.entityCode === "US01").length, 1, "replaced, not doubled");

  await approveExposure(t, cycle as string);
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: r1.recommendationId, actor: admin, action: "ACCEPT" }), /superseded and cannot be decided/);
  assert.deepEqual(await app.fxTrade.questions.preTrades(t, { cycleId: cycle }), []);
  const ok = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: r2.recommendationId, actor: admin, action: "ACCEPT" });
  assert.equal(ok.status, "ACCEPTED");
});

e2e("recalculating and approving the exposure at the same moment: exactly one wins, and the recommendations that can be decided belong to the run that was approved", async () => {
  for (let i = 0; i < 4; i++) {
    const { t, admin, cycle } = await finishedCycle(defaults, "ENTITY", false);
    const results = await Promise.allSettled([
      app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle, actor: admin }),
      app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: cycle, actor: admin } as never),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one of the two gates wins");
    await drain(app);
    if ((await app.exposureManagement.questions.getCycle(t, cycle))!.exposureApprovedAt === null) await approveExposure(t, cycle as string); // the recalculation won; approve its result
    const locked = (await app.exposureManagement.questions.getCycle(t, cycle))!;
    const run = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
    assert.deepEqual([run.runId, run.status, run.frozenAt !== null], [locked.exposureApprovedRunId, "FINISHED", true], "the approved run is the current one and is locked");
    const live = await app.hedgeRecommendation.questions.recommendations(t, cycle);
    assert.ok(live.length > 0 && live.every((r) => r.runId === locked.exposureApprovedRunId), "no recommendation from any other run remains");
    const rec = live.find((r) => r.action === "HEDGE")!;
    assert.equal((await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" })).status, "ACCEPTED");
  }
});

e2e("a recalculated run approved before its run-finished event reaches Hedge Recommendation still gets exactly one set of recommendations; the earlier preview is superseded and a draft is released only at cycle approval", async () => {
  const { t, admin, cycle, recs: previewA } = await finishedCycle(defaults, "ENTITY", false);
  const a = previewA.find((r) => r.action === "HEDGE")!;
  const runA = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
  await app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: cycle, actor: admin } as never);

  // Deliver everything except run B's "run finished" to Hedge Recommendation (Exposure Management still learns B is complete).
  let held: Record<string, unknown> | undefined;
  for (let round = 0; round < 10; round++) {
    let any = false;
    for (const s of [app.exposureManagement, app.exposureAnalysis]) {
      for (const e of (await s.outbox.pending(200)) as unknown as Array<Record<string, unknown> & { eventId: string; type: string }>) {
        if (e.type === "exposure-management.cycle-initiated") await app.exposureAnalysis.commands.onCycleInitiated(e as never);
        else if (e.type === "exposure-analysis.run-started") await app.exposureManagement.commands.onRunStarted(e as never);
        else if (e.type === "exposure-analysis.run-finished") { await app.exposureManagement.commands.onRunFinished(e as never); held = e; }
        await s.outbox.markPublished([e.eventId]);
        any = true;
      }
    }
    if (!any) break;
  }
  assert.ok(held, "run B finished and its event is being held back");
  const runB = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
  assert.notEqual(runB.runId, runA.runId);
  assert.equal(held!.runId, runB.runId);
  assert.equal((await app.hedgeRecommendation.questions.recommendations(t, cycle)).every((r) => r.runId === runA.runId), true, "only A's preview exists so far");

  await approveExposure(t, cycle as string); // approves B before Hedge Recommendation has seen B finish
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle))!.exposureApprovedRunId, runB.runId);

  assert.equal(await app.hedgeRecommendation.commands.onRunFinished(held as never), "ISSUED", "A's preview rows do not stop the approved run's recommendations");
  const live = await app.hedgeRecommendation.questions.recommendations(t, cycle);
  const bRows = live.filter((r) => r.runId === runB.runId);
  assert.ok(bRows.length > 0 && bRows.length === previewA.length, "exactly one set for B");
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, a.recommendationId))!.status, "SUPERSEDED");
  assert.ok(live.filter((r) => r.runId === runA.runId).every((r) => r.status === "SUPERSEDED"), "none of A's rows can be acted on");

  // Replays, with the same or a new event ID, add nothing.
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished(held as never), "IGNORED");
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished({ ...(held as object), eventId: randomUUID() } as never), "IGNORED");
  assert.equal((await app.hedgeRecommendation.questions.recommendations(t, cycle)).filter((r) => r.runId === runB.runId).length, bRows.length);

  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: a.recommendationId, actor: admin, action: "ACCEPT" }), /superseded and cannot be decided/);
  const b = bRows.find((r) => r.action === "HEDGE")!;
  const done = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: b.recommendationId, actor: admin, action: "ACCEPT" });
  assert.equal(done.status, "ACCEPTED");
  assert.deepEqual((await drafts(t, cycle, b.recommendationId)).map((p) => [p.preTradeId === done.preTradeId, p.status]), [[true, "DRAFT"]], "one draft");
  assert.deepEqual(await drafts(t, cycle, a.recommendationId), [], "nothing from A's preview");
  assert.deepEqual((await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin })).preTradeIds, [], "not releasable before the cycle is approved");
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin });
  await drain(app);
  assert.equal((await drafts(t, cycle, b.recommendationId))[0]!.status, "READY");
});

e2e("a decision in progress cannot be replaced: recalculation is refused and a repeated run-finished event makes no replacement recommendation", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const down = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try { await assert.rejects(down.hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /unreachable/); } finally { await down.done(); }
  await assert.rejects(app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: cycle, actor: admin } as never), /exposure is approved, so it cannot be recalculated/);
  const run = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
  const again = { eventId: randomUUID(), tenantId: t, cycleId: cycle, programId: programId("BS"), runId: run.runId };
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished(again), "IGNORED");
  const live = await app.hedgeRecommendation.questions.recommendations(t, cycle);
  assert.deepEqual(live.map((r) => r.recommendationId).sort(), recs.map((r) => r.recommendationId).sort(), "the same recommendations, none replaced");
  assert.equal(live.find((r) => r.recommendationId === rec.recommendationId)!.status, "DECIDING");
  assert.equal((await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" })).status, "ACCEPTED");
  assert.equal((await drafts(t, cycle, rec.recommendationId)).length, 1);
});

e2e("a trade arriving after the exposure cutoff changes nothing approved, even with an earlier trade date; a retried decision gives one draft that only cycle approval releases; the next cycle picks the trade up", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const run = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
  const snapshot = async () => JSON.stringify([
    await app.exposureAnalysis.questions.exposures(t, run.runId), await app.exposureAnalysis.questions.netExposures(t, run.runId), await app.exposureAnalysis.questions.hedgeRows(t, run.runId),
    (await app.hedgeRecommendation.questions.recommendations(t, cycle)).map((r) => [r.recommendationId, r.amount, r.hedgedAmount, r.neededAmount]),
  ]);
  const before = await snapshot();

  const late = [
    "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference",
    "LATE-1,SIMFX,US01,Sim Bank,2026-11-10,2026-12-15,EUR,400.0000,USD,440.0000,FORWARD,SELL,BS,",
  ].join("\n");
  const imported = await app.fxTrade.commands.importExecutedTrades({ tenantId: t, rows: parseExecutedFile(late), by: "simulator" });
  assert.equal(imported.stored, 1, "the trade is stored for its program");
  await drain(app);
  assert.equal(await snapshot(), before, "the approved exposure, hedge rows and recommendations are exactly as approved");
  await assert.rejects(app.exposureManagement.commands.rerunCycle({ tenantId: t, cycleId: cycle, actor: admin } as never), /cannot be recalculated/);
  assert.equal(await app.exposureAnalysis.commands.onCycleInitiated({ eventId: randomUUID(), tenantId: t, cycleId: cycle } as never), "IGNORED", "the backend does not recalculate a locked cycle");
  assert.equal(await snapshot(), before);

  // One draft however many times the decision is tried, and it is only releasable once the cycle is approved.
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const down = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try { await assert.rejects(down.hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /unreachable/); } finally { await down.done(); }
  const done = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" });
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /cannot be decided/);
  const made = await drafts(t, cycle, rec.recommendationId);
  assert.deepEqual(made.map((p) => [p.preTradeId === done.preTradeId, p.status]), [[true, "DRAFT"]]);
  assert.deepEqual((await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin })).preTradeIds, [], "a draft is not releasable before the cycle is approved");
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin });
  await drain(app);
  assert.equal((await drafts(t, cycle, rec.recommendationId))[0]!.status, "READY");

  // A later cycle is the one that counts the late trade.
  clock.now = new Date("2026-11-12T23:00:00Z");
  await sendRates(t, "2026-11-12", "1.1");
  await sendBalances(t, "2026-11-12");
  await drain(app);
  const [next] = await startDueCycles(app, t, "2026-11-13", admin);
  await drain(app);
  const nextRun = (await app.exposureAnalysis.questions.currentRun(t, next as never))!;
  assert.equal(nextRun.hedgeCounts!.trades, 1);
  const us = (await app.exposureAnalysis.questions.netExposures(t, nextRun.runId)).find((g) => g.entityCode === "US01")!;
  assert.equal(us.hedges.exposureAmount, "-400.00");
  assert.equal(await snapshot(), before, "and the earlier approved cycle is still untouched");
});

e2e("deciding and changing the policy need the right permissions on the program", async () => {
  const { t, recs } = await finishedCycle(defaults);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const user = async (role: "VIEWER" | "TREASURY_REVIEWER" | "TREASURY_APPROVER"): Promise<Actor> => ({ kind: "user", userId: await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: [role] }, ops) as never });
  const id = recs.find((r) => r.action === "HEDGE")!.recommendationId;
  const viewer = await user("VIEWER");
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: id, actor: viewer, action: "ACCEPT" }), /not allowed \(hedge-recommendation:accept\)/);
  await assert.rejects(app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: await user("TREASURY_REVIEWER"), policy: defaults }), /not allowed \(hedge-policy:manage\)/);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, id))!.status, "OPEN", "a refused decision changes nothing");
  const done = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: id, actor: await user("TREASURY_APPROVER"), action: "ACCEPT" });
  assert.equal(done.status, "ACCEPTED");
});

e2e("the same run-finished event delivered twice changes nothing the second time, and an event for a run that is no longer current is ignored", async () => {
  const { t, cycle, recs } = await finishedCycle(defaults, "ENTITY", false); // before Approve Exposure, where a recalculation may still replace the preview
  const run = (await app.exposureAnalysis.questions.currentRun(t, cycle))!;
  const event = { eventId: randomUUID(), tenantId: t, cycleId: cycle, programId: programId("BS"), runId: run.runId };
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished(event), "ISSUED");
  const once = (await app.hedgeRecommendation.questions.recommendations(t, cycle)).map((r) => r.recommendationId);
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished(event), "IGNORED");
  assert.deepEqual((await app.hedgeRecommendation.questions.recommendations(t, cycle)).map((r) => r.recommendationId), once);
  assert.equal(await app.hedgeRecommendation.commands.onRunFinished({ ...event, eventId: randomUUID(), runId: randomUUID() }), "IGNORED", "not the cycle's current run");
  assert.equal(recs.length, once.length);
});

e2e("a group without an entity is booked by the policy's default trading entity; with none configured it gets no actionable recommendation and says why", async () => {
  const roundTo100 = { ...defaults, roundingDefault: "100" };
  const without = await finishedCycle({ ...roundTo100, tradingEntityCode: null }, "GROUP_NATURAL");
  const none = without.recs.find((r) => r.currencyPair === "EUR-USD")!;
  assert.deepEqual([none.entityCode, none.action, none.status, none.reason, none.tradingEntityCode, none.direction, none.amount], [null, "NONE", "NONE", "NO_TRADING_ENTITY", null, null, null]);
  assert.match(NO_ACTION_MESSAGES.NO_TRADING_ENTITY, /default trading entity/);

  const withDefault = await finishedCycle(roundTo100, "GROUP_NATURAL");
  const rec = withDefault.recs.find((r) => r.currencyPair === "EUR-USD")!;
  assert.deepEqual([rec.entityCode, rec.action, rec.tradingEntityCode, rec.direction, rec.amount, rec.status], [null, "HEDGE", "US01", "SELL", "500.00", "OPEN"]);
  const accepted = await app.hedgeRecommendation.commands.decide({ tenantId: withDefault.t, recommendationId: rec.recommendationId, actor: withDefault.admin, action: "ACCEPT" });
  assert.equal((await app.fxTrade.questions.getPreTrade(withDefault.t, accepted.preTradeId!))!.tradingEntityCode, "US01");
});

e2e("a 50% override entered as USD-EUR applies to the EUR-USD group instead of silently using the default", async () => {
  const { recs } = await finishedCycle({ ...defaults, roundingDefault: "100", ratioOverrides: [{ pair: "USD-EUR", ratio: "0.5" }] });
  const us = recs.find((r) => r.entityCode === "US01")!;
  assert.deepEqual([us.currencyPair, us.ratio, us.amount, us.direction], ["EUR-USD", "0.5", "500.00", "SELL"]);
  const { t, admin } = await finishedCycle();
  await assert.rejects(
    app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: admin, policy: { ...defaults, ratioOverrides: [{ pair: "EUR-USD", ratio: "0.5" }, { pair: "USD-EUR", ratio: "0.8" }] } }),
    /appears twice/,
  );
});

/** A second Hedge Recommendation over the same database whose call to FX Trade is replaced, to play out failures. */
function withFxTrade(createPreTrades: (input: never) => Promise<readonly { recommendationId: string; preTradeId: string }[]>, lookupFails = false, statusFails = false) {
  const db = connectHr(url!);
  const hr = createHedgeRecommendation(db, {
    access: app.identity.questions, management: app.exposureManagement.questions, analysis: app.exposureAnalysis.questions, masterData: app.masterData.questions,
    rates: app.fxRate.questions,
    preTrades: { ...app.fxTrade.questions, ...(lookupFails ? { preTrades: async () => { throw new Error("FX Trade lookup unavailable"); } } : {}), ...(statusFails ? { getPreTrade: async () => { throw new Error("FX Trade status unavailable"); } } : {}) }, createPreTrades: createPreTrades as never,
  }, { now: () => clock.now });
  return { hr, done: () => db.destroy() };
}
const drafts = async (t: TenantId, cycle: never, recommendationId: string) => (await app.fxTrade.questions.preTrades(t, { cycleId: cycle })).filter((p) => p.recommendationId === recommendationId);
const real = (input: never) => app.fxTrade.commands.createPreTrades(input);

e2e("accept and dismiss racing: exactly one wins, and only an accept leaves a draft, matching the recorded amount, that approval releases", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const { t, admin, cycle, recs } = await finishedCycle(defaults);
    const rec = recs.find((r) => r.action === "HEDGE")!;
    const results = await Promise.allSettled([
      app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }),
      app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "DISMISS" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one decision wins");
    const final = (await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!;
    seen.add(final.status);
    await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle, actor: admin });
    await drain(app);
    const made = await drafts(t, cycle, rec.recommendationId);
    if (final.status === "DISMISSED") assert.deepEqual(made, [], "a dismissal that won leaves nothing to release");
    else {
      assert.equal(final.status, "ACCEPTED");
      assert.deepEqual(made.map((p) => [p.status, p.legs[0]!.dealAmount]), [["READY", "1000.0000"]]);
      assert.equal(final.decidedAmount, "1000.00");
    }
  }
  assert.ok(seen.size >= 1);
});

e2e("an override racing an accept: one draft, and its amount is the winning decision's", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const results = await Promise.allSettled([
    app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }),
    app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "300" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const final = (await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!;
  const made = await drafts(t, cycle, rec.recommendationId);
  assert.equal(made.length, 1);
  assert.equal(Number(made[0]!.legs[0]!.dealAmount), Number(final.decidedAmount));
});

e2e("a definite refusal from FX Trade reopens the recommendation and leaves no draft; it can then be dismissed", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const { hr, done } = withFxTrade(async () => { throw Object.assign(new Error("no"), { problems: ["entity is not a hedge execution entity"] }); });
  try {
    await assert.rejects(hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /FX Trade refused the pre-trade: entity is not a hedge execution entity/);
    assert.equal((await hr.questions.getRecommendation(t, rec.recommendationId))!.status, "OPEN");
    await drain(app);
    assert.deepEqual(await trailOf(t, { targetType: "recommendation" }), [], "a refused claim is not a decision: nothing in the trail");
    assert.equal((await hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "DISMISS" })).status, "DISMISSED");
    assert.deepEqual(await drafts(t, cycle, rec.recommendationId), []);
    await drain(app);
    assert.deepEqual((await trailOf(t, { targetType: "recommendation" })).map((r) => r.action), ["recommendation.dismissed"], "only the dismissal that stood");
  } finally { await done(); }
});

e2e("FX Trade answering after a failure is not mistaken for a refusal: the draft that exists is the one recorded, exactly once", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const { hr, done } = withFxTrade(async (input) => { await real(input); throw new Error("connection reset after commit"); });
  try {
    const out = await hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "300" });
    assert.deepEqual([out.status, out.decidedAmount], ["OVERRIDDEN", "300.00"]);
    assert.equal((await drafts(t, cycle, rec.recommendationId)).length, 1);
    assert.equal((await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "300" }).catch((e: Error) => e.message)).toString().includes("overridden"), true, "deciding again is refused, not repeated");
    await drain(app);
    assert.deepEqual((await trailOf(t, { targetType: "recommendation" })).map((r) => [r.action, r.fields]), [["recommendation.overridden", ["amount"]]], "exactly one record, written when the outcome was confirmed");
  } finally { await done(); }
});

e2e("when FX Trade cannot be reached the winning decision stays recorded: dismissal is refused, a retry finishes it with the recorded amount, and nothing else can create a draft", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const down = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try {
    await assert.rejects(down.hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "300" }), /unreachable/);
  } finally { await down.done(); }
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!.status, "DECIDING");
  await drain(app);
  assert.deepEqual(await trailOf(t, { targetType: "recommendation" }), [], "a claim still waiting for FX Trade is not in the trail yet");
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "DISMISS" }), /already in progress/);
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /already in progress/);
  // The retry may pass a different amount; the recorded decision is what is made.
  const out = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "999" });
  assert.deepEqual([out.status, out.decidedAmount], ["OVERRIDDEN", "300.00"]);
  const made = await drafts(t, cycle, rec.recommendationId);
  assert.deepEqual(made.map((p) => p.legs[0]!.dealAmount), ["300.0000"]);
  await drain(app);
  assert.deepEqual((await trailOf(t, { targetType: "recommendation" })).map((r) => r.action), ["recommendation.overridden"], "the retry that confirmed it wrote the one record");
});

e2e("approval settles a decision that never got its pre-trade: it lapses, and nothing releasable exists", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const down = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try {
    await assert.rejects(down.hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /unreachable/);
  } finally { await down.done(); }
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle, actor: admin });
  await drain(app);
  const after = (await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!;
  assert.deepEqual([after.status, after.decidedBy, after.preTradeId], ["LAPSED", null, null]);
  assert.deepEqual(await drafts(t, cycle, rec.recommendationId), []);
  assert.deepEqual(await trailOf(t, { targetType: "recommendation" }), [], "a decision that lapsed never took effect: no success record");
});

e2e("cycle approval that finds the draft a stuck decision made confirms it: exactly one record, by the person who decided", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const label = (await trailOf(t)).find((r) => r.action === "program.defined")!.actor;
  // FX Trade makes the draft, then neither the answer nor the lookup that would recover it gets back.
  const stuck = withFxTrade(async (input) => { await real(input); throw new Error("connection reset after commit"); }, true);
  try { await assert.rejects(stuck.hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /unavailable|reset/); } finally { await stuck.done(); }
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!.status, "DECIDING");
  assert.equal((await drafts(t, cycle, rec.recommendationId)).length, 1);
  await drain(app);
  assert.deepEqual(await trailOf(t, { targetType: "recommendation" }), []);
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle, actor: admin });
  await drain(app);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!.status, "ACCEPTED");
  await drain(app);
  assert.deepEqual((await trailOf(t, { targetType: "recommendation" })).map((r) => [r.action, r.actor, r.targetId]), [["recommendation.accepted", label, rec.recommendationId]]);
  assert.equal((await drafts(t, cycle, rec.recommendationId)).length, 1);
});

/** The tenant's whole trail, oldest first, read as its admin. */
const trailOf = async (t: TenantId, over: object = {}) => (await app.audit.questions.trail({ tenantId: t, actor: admins.get(t)!, limit: 500, ...over })).records;

e2e("every governed change reaches the audit trail with who did it, in order; people's changes are in it and routine loads are not; the chain verifies", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults); // defines the program, sets the policy, starts the cycle, approves the exposure
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const adminLabel = (await trailOf(t)).find((r) => r.action === "program.defined")!.actor;
  assert.ok(adminLabel.startsWith("user:"));

  // A person changes master data; a feed does the same (finishedCycle loaded its entities as "test").
  const person = adminLabel;
  await app.masterData.commands.applyCurrencies({ tenantId: t, sourceSystem: "manual", asOf: D0, mode: "PARTIAL", rows: [{ code: "BRL", isNdf: true }] as never, by: person });
  await app.masterData.commands.applyCurrencies({ tenantId: t, sourceSystem: "erp", asOf: D0, mode: "PARTIAL", rows: [{ code: "INR", isNdf: true }] as never, by: "erp-sync" });

  await drain(app); // positions follow arrival at Audit, so each step is delivered before the next to keep this list in the order things happened
  await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" });
  await drain(app);
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin });
  await drain(app);
  const exported = await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin });
  assert.equal(exported.preTradeIds.length, 1);
  await drain(app);

  const trail = await trailOf(t);
  const line = (r: (typeof trail)[number]) => `${r.action} ${r.targetType}${r.programId ? ` [${r.programId}]` : ""}`;
  assert.deepEqual(trail.map(line), [
    "program.enabled program [BS]", "user.added user", "program.defined program [BS]", "tenant.segregation-of-duties-set tenant-setting", "hedge-policy.set hedge-policy [BS]",
    "cycle.started cycle [BS]", "exposure.approved cycle [BS]", "master-data.currency-changed change-set",
    "recommendation.accepted recommendation [BS]", "cycle.approved cycle [BS]", "pre-trade.sent pre-trade [BS]",
  ], "in order; the feed's currency load is not there, the person's is");
  assert.deepEqual(trail.filter((r) => ["cycle.started", "exposure.approved", "cycle.approved", "recommendation.accepted"].includes(r.action)).map((r) => [r.actor === adminLabel, r.targetId === (r.targetType === "cycle" ? cycle : rec.recommendationId)]), Array(4).fill([true, true]));
  assert.deepEqual(trail.find((r) => r.action === "hedge-policy.set")!.fields, ["policy"], "the first policy for a program has no earlier one to compare with");
  assert.ok(trail.every((r, i) => r.seq === i + 1 && r.tenantId === t));
  assert.deepEqual(await app.audit.questions.verify(t, admin), { ok: true, checked: trail.length, brokenAtSeq: null });

  // A later change to the policy names only the fields that changed.
  await app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: admin, policy: { ...defaults, defaultRatio: "0.5", tenor: "3M" } as never });
  await drain(app);
  assert.deepEqual((await trailOf(t, { action: "hedge-policy.set" })).map((r) => r.fields), [["policy"], ["defaultRatio", "tenor"]]);

  // Delivering any record again, as a repeated event would, adds nothing.
  const before = (await trailOf(t)).length;
  for (const r of await trailOf(t)) assert.equal(await app.audit.commands.record({ type: "exposure-management.change-recorded", eventId: r.recordId, occurredAt: r.occurredAt, tenantId: t, programId: r.programId, actor: r.actor, action: r.action, targetType: r.targetType, targetId: r.targetId, fields: r.fields }), "DUPLICATE");
  assert.equal((await trailOf(t)).length, before);
});

e2e("a decision that loses a race, or a retry of the one that won, leaves exactly one record; refused commands leave none", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults);
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const results = await Promise.allSettled([
    app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }),
    app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "DISMISS" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await drain(app);
  const decided = (await trailOf(t)).filter((r) => r.targetType === "recommendation");
  assert.equal(decided.length, 1, "only the decision that won is recorded");
  assert.ok(["recommendation.accepted", "recommendation.dismissed"].includes(decided[0]!.action));

  const fresh = await finishedCycle(defaults);
  const r2 = fresh.recs.find((r) => r.action === "HEDGE")!;
  const down = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try { await assert.rejects(down.hr.commands.decide({ tenantId: fresh.t, recommendationId: r2.recommendationId, actor: fresh.admin, action: "ACCEPT" }), /unreachable/); } finally { await down.done(); }
  await app.hedgeRecommendation.commands.decide({ tenantId: fresh.t, recommendationId: r2.recommendationId, actor: fresh.admin, action: "ACCEPT" }); // the retry finishes the claimed decision
  await assert.rejects(app.hedgeRecommendation.commands.decide({ tenantId: fresh.t, recommendationId: r2.recommendationId, actor: fresh.admin, action: "ACCEPT" }), /cannot be decided/);
  await assert.rejects(app.exposureManagement.commands.rerunCycle({ tenantId: fresh.t, cycleId: fresh.cycle as string, actor: fresh.admin } as never), /cannot be recalculated/);
  await drain(app);
  assert.equal((await trailOf(fresh.t)).filter((r) => r.targetType === "recommendation").length, 1, "one accept, however many tries");
  assert.equal((await trailOf(fresh.t)).filter((r) => r.action === "cycle.rerun").length, 0, "a refused command records nothing");
  assert.equal(cycle === fresh.cycle, false);
});

e2e("who may read the trail: approvers and admins, not viewers or reviewers; every use of the platform role is recorded, and users and roles are recorded as they change", async () => {
  const { t, admin } = await finishedCycle(defaults);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const person = async (role: "VIEWER" | "TREASURY_REVIEWER" | "TREASURY_APPROVER"): Promise<{ actor: Actor; id: string }> => {
    const id = (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: [role] }, ops)) as string;
    return { actor: { kind: "user", userId: id as never }, id };
  };
  const viewer = await person("VIEWER"), reviewer = await person("TREASURY_REVIEWER"), approver = await person("TREASURY_APPROVER");
  for (const who of [viewer, reviewer]) await assert.rejects(app.audit.questions.trail({ tenantId: t, actor: who.actor }), /not allowed \(audit:read\)/);
  await assert.rejects(app.audit.questions.verify(t, viewer.actor), /not allowed \(audit:read\)/);
  assert.ok((await app.audit.questions.trail({ tenantId: t, actor: approver.actor })).records.length > 0);
  assert.equal((await app.audit.questions.verify(t, approver.actor)).ok, true);

  // The platform role reads the trail; that use is itself in the trail (the read sees the trail as it stood before it).
  await app.audit.questions.trail({ tenantId: t, actor: { kind: "platform", platformUserId: ops as never } });
  await app.identity.commands.grantRole(t, approver.id as never, "TREASURY_ADMIN", ops);
  await app.identity.commands.revokeRole(t, viewer.id as never, "VIEWER", ops);
  await app.identity.commands.setProgramRestriction(t, reviewer.id as never, [programId("BS")], ops);
  await app.identity.commands.disableUser(t, reviewer.id as never, ops);
  await app.identity.commands.disableUser(t, reviewer.id as never, ops); // already disabled: not a change
  await drain(app);
  const trail = await trailOf(t);
  const rows = (action: string) => trail.filter((r) => r.action === action);
  assert.equal(rows("user.added").length, 4, "the admin and the three people");
  assert.deepEqual(rows("platform-role.used").map((r) => [r.actor, r.targetType, r.targetId]), [[`platform:${ops}`, "permission", "audit:read"]]);
  assert.deepEqual([rows("role.granted").at(-1)!.targetId, rows("role.revoked")[0]!.targetId], [`${approver.id}/TREASURY_ADMIN`, `${viewer.id}/VIEWER`]);
  assert.deepEqual(rows("user.program-restriction-set").map((r) => r.fields), [["programs"]]);
  assert.equal(rows("user.disabled").length, 1);
  assert.deepEqual(await app.audit.questions.verify(t, admin), { ok: true, checked: trail.length, brokenAtSeq: null });
});

e2e("a reader limited to a program (Identity's restriction) sees only that program's records in an unfiltered trail, none of the tenant-wide ones, and cannot verify the chain", async () => {
  const { t, admin, cycle } = await finishedCycle(defaults);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const mk = async (limit: boolean) => {
    const id = (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_APPROVER"] }, ops)) as never;
    if (limit) await app.identity.commands.setProgramRestriction(t, id, [programId("BS")], ops);
    return { kind: "user", userId: id } as Actor;
  };
  const free = await mk(false), limited = await mk(true);
  // Another program in the same tenant, so there is something outside the limit.
  await app.identity.commands.enableProgram(t, programId("FC"), ops);
  await drain(app);
  const all = (await app.audit.questions.trail({ tenantId: t, actor: free, limit: 500 })).records;
  assert.ok(all.some((r) => r.programId === programId("FC")) && all.some((r) => r.programId === null) && all.some((r) => r.programId === programId("BS")));
  const mine = (await app.audit.questions.trail({ tenantId: t, actor: limited, limit: 500 })).records;
  assert.ok(mine.length > 0 && mine.every((r) => r.programId === programId("BS")), "only BS, and nothing tenant-wide");
  assert.deepEqual(mine.map((r) => r.seq), all.filter((r) => r.programId === programId("BS")).map((r) => r.seq));
  await assert.rejects(app.audit.questions.trail({ tenantId: t, actor: limited, programId: programId("FC") }), /program-restricted/);
  await assert.rejects(app.audit.questions.verify(t, limited), /program-restricted/);
  assert.equal((await app.audit.questions.verify(t, free)).ok, true);
  assert.equal((await app.audit.questions.verify(t, admin)).ok, true);
  assert.ok(cycle);
});

e2e("an exposure-currency mapping change is recorded in its own program: a reviewer limited to that program sees it, not the other program's, and no mapping values reach Audit", async () => {
  const { t, admin } = await finishedCycle(defaults);
  const person = (await trailOf(t)).find((r) => r.action === "program.defined")!.actor;
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const limitedId = (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_APPROVER"] }, ops)) as never;
  await app.identity.commands.setProgramRestriction(t, limitedId, [programId("BS")], ops);
  const limited = { kind: "user", userId: limitedId } as Actor;
  // The same source sends both programs' mappings.
  await app.masterData.commands.applyPairExposureCurrencies({ tenantId: t, sourceSystem: "erp", asOf: D0, mode: "SNAPSHOT", programCode: "BS", rows: [{ pair: "EUR-GBP", exposureCurrency: "EUR" }], by: person });
  await app.masterData.commands.applyPairExposureCurrencies({ tenantId: t, sourceSystem: "erp", asOf: D0, mode: "SNAPSHOT", programCode: "FC", rows: [{ pair: "EUR-GBP", exposureCurrency: "GBP" }], by: person });
  await drain(app);
  const mapping = (rs: readonly { action: string; programId: unknown }[]) => rs.filter((r) => r.action === "master-data.exposure_currency-changed").map((r) => r.programId);
  assert.deepEqual(mapping((await app.audit.questions.trail({ tenantId: t, actor: admin, limit: 500 })).records).sort(), ["BS", "FC"]);
  const mine = (await app.audit.questions.trail({ tenantId: t, actor: limited, limit: 500 })).records;
  assert.deepEqual(mapping(mine), ["BS"], "the limited reviewer sees BS's mapping change and not FC's");
  assert.ok(mine.filter((r) => r.action === "master-data.exposure_currency-changed").every((r) => r.fields.length === 0));
});

e2e("segregation of duties across the real services: the starter cannot approve the exposure, a decider cannot approve the cycle, others can, refusals are audited, and a draft is still released only at cycle approval", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults, "ENTITY", false, true); // admin started the cycle; the tenant has segregation of duties on
  assert.deepEqual(await app.exposureManagement.questions.tenantSettings(t), { segregationOfDuties: true });
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const approver = async (): Promise<Actor> => ({ kind: "user", userId: (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_APPROVER"] }, ops)) as never });
  const [a, b] = [await approver(), await approver()];

  await assert.rejects(app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle as string, actor: admin }), /you started or reran this cycle/);
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle))!.exposureApprovedAt, null, "the refusal changed nothing");
  await drain(app);
  await app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle as string, actor: a });
  await drain(app);

  const rec = recs.find((r) => r.action === "HEDGE")!;
  await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: a, action: "ACCEPT" });
  await drain(app); // positions follow arrival at Audit, so deliver each step before the next to keep the trail in the order things happened
  await assert.rejects(app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: a }), /you accepted or overrode a hedge on this cycle/);
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle))!.approvedAt, null);
  assert.deepEqual((await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin })).preTradeIds, [], "the draft is not releasable while the cycle is unapproved");
  await drain(app);
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: b });
  await drain(app);
  assert.equal((await drafts(t, cycle, rec.recommendationId))[0]!.status, "READY");

  const trail = (await trailOf(t)).map((r) => `${r.action} ${r.actor === `user:${(a as { userId: string }).userId}` ? "A" : r.actor === `user:${(b as { userId: string }).userId}` ? "B" : "admin"}`);
  assert.deepEqual(trail.filter((l) => /refused|approved|accepted/.test(l)), [
    "exposure.approval-refused-by-segregation-of-duties admin", "exposure.approved A", "recommendation.accepted A", "cycle.approval-refused-by-segregation-of-duties A", "cycle.approved B",
  ]);
});

e2e("a tenant admin switches segregation of duties off, and a one-person team can then run a cycle start to end; switching it on again is audited too", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults, "ENTITY", false, true);
  const analyst: Actor = { kind: "user", userId: (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ANALYST"] }, (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string)) as never };
  await assert.rejects(app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: analyst }), /not allowed \(authorization:manage\)/);
  assert.equal(await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: admin }), true);
  assert.equal(await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: admin }), false, "no change, no record");
  assert.deepEqual(await app.exposureManagement.questions.tenantSettings(t), { segregationOfDuties: false });

  const rec = recs.find((r) => r.action === "HEDGE")!;
  await approveExposure(t, cycle as string); // the starter approves
  await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" });
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin }); // the decider approves
  await drain(app);
  assert.equal((await app.exposureManagement.questions.getCycle(t, cycle))!.approvedBy, (await trailOf(t)).find((r) => r.action === "program.defined")!.actor);
  assert.equal((await trailOf(t, { action: "tenant.segregation-of-duties-set" })).length, 1, "one change recorded: the repeat added nothing");
  assert.equal(await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: true, actor: admin }), true);
  await drain(app);
  assert.deepEqual((await trailOf(t, { action: "tenant.segregation-of-duties-set" })).map((r) => r.fields), [["segregationOfDuties"], ["segregationOfDuties"]]);
  assert.deepEqual(await app.exposureManagement.questions.tenantSettings(t), { segregationOfDuties: true });
});

// Maximum hedge amount (decision 0016). The US01 group recommends selling 1,000 EUR; at 1.1 a maximum of 330 USD is 300 EUR.
const split = (over: object) => ({ ...defaults, roundingDefault: "10", maxHedgeDisplay: "330", ...over });
const us01 = (recs: readonly { entityCode: string | null; action: string }[]) => recs.find((r) => r.entityCode === "US01" && r.action === "HEDGE") as Awaited<ReturnType<typeof finishedCycle>>["recs"][number];

e2e("maximum hedge amount: a larger recommendation is split evenly, or as the maximum plus a remainder; a level's own maximum replaces the program's; a small last part is merged", async () => {
  const even = us01((await finishedCycle(split({ splitMethod: "EVEN" }))).recs);
  assert.deepEqual([even.amount, even.maxExposureAmount, even.splitMethod, even.parts.map((p) => p.amount)], ["1000.00", "300.00", "EVEN", ["250.00", "250.00", "250.00", "250.00"]]);
  const thr = us01((await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }))).recs);
  assert.deepEqual(thr.parts.map((p) => p.amount), ["300.00", "300.00", "300.00", "100.00"]);
  assert.ok(thr.parts.every((p) => p.preTradeId === null && p.followUp === "NOT_STARTED") && thr.splitNote === null);

  // The cycle runs at ENTITY level: that level's own maximum (660 USD = 600 EUR) replaces the program's; another level's does not matter.
  const level = us01((await finishedCycle(split({ splitMethod: "EVEN", maxHedgeOverrides: [{ nettingLevel: "ENTITY", maxHedgeDisplay: "660" }, { nettingLevel: "REGION", maxHedgeDisplay: "110" }] }))).recs);
  assert.deepEqual([level.maxExposureAmount, level.parts.map((p) => p.amount)], ["600.00", ["500.00", "500.00"]]);
  // A minimum of 200 USD is 181.82 EUR: the 100 left over is below it and is added to the part before.
  const merged = us01((await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER", minHedgeDisplay: "200" }))).recs);
  assert.deepEqual(merged.parts.map((p) => p.amount), ["300.00", "300.00", "400.00"]);
  assert.match(merged.splitNote!, /added to the part before/);
  // No maximum: one part, as before. A maximum at or above the amount: also one part, with the maximum recorded.
  const none = us01((await finishedCycle(defaults)).recs);
  assert.deepEqual([none.parts.map((p) => p.amount), none.maxExposureAmount, none.splitMethod], [["1000.00"], null, null]);
  const roomy = us01((await finishedCycle(split({ maxHedgeDisplay: "5000" }))).recs);
  assert.deepEqual([roomy.parts.map((p) => p.amount), roomy.maxExposureAmount], [["1000.00"], "4545.4545"]);
  // A rounding step as coarse as the amount cannot be split finer: one part of 1,000, larger than the maximum, and it says so.
  const coarse = us01((await finishedCycle(split({ roundingDefault: "1000", splitMethod: "EVEN" }))).recs);
  assert.deepEqual([coarse.parts.map((p) => p.amount), coarse.splitNote?.includes("larger than the maximum")], [["1000.00"], true]);
  // Saved and read back; a bad policy is refused.
  const pol = await app.hedgeRecommendation.questions.policy((await finishedCycle(split({ maxHedgeOverrides: [{ nettingLevel: "ENTITY", maxHedgeDisplay: "660" }] }))).t, programId("BS"));
  assert.deepEqual([pol.maxHedgeDisplay, pol.maxHedgeOverrides, pol.splitMethod], ["330.00", [{ nettingLevel: "ENTITY", maxHedgeDisplay: "660.00" }], "EVEN"]);
  const t0 = tenantWithProgram();
  const bad = async (policy: object) => app.hedgeRecommendation.commands.setPolicy({ tenantId: await t0, programId: programId("BS"), actor: admins.get(await t0)!, policy: policy as never }).then(() => "saved", (e: Error) => e.message);
  assert.match(await bad(split({ maxHedgeDisplay: "0" })), /maximum hedge amount must be a decimal above 0/);
  assert.match(await bad(split({ minHedgeDisplay: "400" })), /must not be below the minimum/);
  assert.match(await bad(split({ maxHedgeOverrides: [{ nettingLevel: "DESK", maxHedgeDisplay: "10" }] })), /must be one of/);
  assert.match(await bad(split({ maxHedgeOverrides: [{ nettingLevel: "ENTITY", maxHedgeDisplay: "10" }, { nettingLevel: "ENTITY", maxHedgeDisplay: "20" }] })), /appears twice/);
  assert.match(await bad(split({ splitMethod: "RANDOM" })), /split method must be one of/);
});

e2e("a split recommendation: accepting makes one draft per part, approval releases them all, and the follow-up of the whole follows its parts", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }));
  const rec = us01(recs);
  const accepted = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" });
  assert.deepEqual([accepted.status, accepted.decidedAmount, accepted.followUp], ["ACCEPTED", "1000.00", "OPEN"]);
  const made = await drafts(t, cycle, rec.recommendationId);
  assert.deepEqual(made.map((p) => [p.partNo, p.legs[0]!.dealAmount, p.status]), [[1, "300.0000", "DRAFT"], [2, "300.0000", "DRAFT"], [3, "300.0000", "DRAFT"], [4, "100.0000", "DRAFT"]]);
  assert.equal(new Set(made.map((p) => p.legs[0]!.valueDate)).size, 1, "every part has the recommendation's value date");
  assert.deepEqual(accepted.parts.map((p) => p.preTradeId), made.map((p) => p.preTradeId));
  assert.equal(accepted.preTradeId, made[0]!.preTradeId);
  await drain(app);
  assert.deepEqual((await trailOf(t, { targetType: "recommendation" })).map((r) => r.action), ["recommendation.accepted"], "one decision, one record");

  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle, actor: admin });
  await drain(app);
  assert.ok((await drafts(t, cycle, rec.recommendationId)).every((p) => p.status === "READY"), "approval released every part");
  const sent = await app.fxTrade.commands.exportPreTrades({ tenantId: t, actor: admin });
  assert.equal(sent.preTradeIds.length, 4);
  const [h, ...rows] = sent.file.trim().split("\n").map((l) => l.split(","));
  const lines = rows.map((r) => Object.fromEntries(h!.map((k, i) => [k, r[i]!])));
  const fill = async (part: number) => {
    const out = lines.find((l) => l.deal_amount === (part === 4 ? "100.0000" : "300.0000") && !used.has(l.pre_trade_reference!))!;
    used.add(out.pre_trade_reference!);
    const reply = [
      "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference",
      `SIM-${part},SIMFX,${out.trading_entity},Sim Bank,2026-11-12,${out.value_date},${out.deal_currency},${out.deal_amount},${out.settlement_currency},1105.0000,${out.instrument},${out.buy_sell},${out.hedging_program_id},${out.pre_trade_reference}`,
    ].join("\n");
    const r = await app.fxTrade.commands.importExecutedTrades({ tenantId: t, rows: parseExecutedFile(reply), by: "simulator" });
    assert.deepEqual([r.stored, r.matched], [1, 1]);
    await drain(app);
    return (await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!;
  };
  const used = new Set<string>();
  const one = await fill(1);
  assert.deepEqual([one.followUp, one.parts.map((p) => p.followUp)], ["PARTLY_EXECUTED", ["EXECUTED", "OPEN", "OPEN", "OPEN"]]);
  await fill(2); await fill(4);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(t, rec.recommendationId))!.followUp, "PARTLY_EXECUTED", "one part is still open");
  const last = await fill(3);
  assert.deepEqual([last.followUp, last.parts.map((p) => p.followUp)], ["EXECUTED", ["EXECUTED", "EXECUTED", "EXECUTED", "EXECUTED"]]);
});

e2e("overriding a split recommendation splits the new amount the same way and explains it; a refusal from FX Trade puts the recommended parts and note back", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(split({ splitMethod: "EVEN" }));
  const rec = us01(recs);
  const { hr, done } = withFxTrade(async () => { throw Object.assign(new Error("no"), { problems: ["entity is not a hedge execution entity"] }); });
  try {
    await assert.rejects(hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "700" }), /FX Trade refused/);
    const back = (await hr.questions.getRecommendation(t, rec.recommendationId))!;
    assert.deepEqual([back.status, back.parts.map((p) => p.amount)], ["OPEN", ["250.00", "250.00", "250.00", "250.00"]], "the recommended parts, not the override's");
  } finally { await done(); }
  const o = await app.hedgeRecommendation.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "OVERRIDE", amount: "700" });
  assert.deepEqual([o.status, o.decidedAmount, o.amount, o.parts.map((p) => p.amount)], ["OVERRIDDEN", "700.00", "1000.00", ["240.00", "230.00", "230.00"]]);
  assert.deepEqual((await drafts(t, cycle, rec.recommendationId)).map((p) => [p.partNo, p.legs[0]!.dealAmount]), [[1, "240.0000"], [2, "230.0000"], [3, "230.0000"]]);
});

e2e("the split note follows the parts: an override that merges a remainder gets the note, one that does not loses it, and a refusal restores the original either way", async () => {
  const refused = () => withFxTrade(async () => { throw Object.assign(new Error("no"), { problems: ["entity is not a hedge execution entity"] }); });
  const view = async (hr: { questions: typeof app.hedgeRecommendation.questions }, t: TenantId, id: string) => { const r = (await hr.questions.getRecommendation(t, id))!; return [r.status, r.parts.map((p) => p.amount), r.splitNote]; };
  // Maximum 200 EUR, minimum 100 EUR: the original 1,000 is five parts of 200 with no note. Overriding to 450 leaves 50, below the minimum.
  const a = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER", maxHedgeDisplay: "220", minHedgeDisplay: "110" }));
  const ra = us01(a.recs);
  assert.deepEqual([ra.parts.map((p) => p.amount), ra.splitNote], [["200.00", "200.00", "200.00", "200.00", "200.00"], null]);
  const x = refused();
  try {
    await assert.rejects(x.hr.commands.decide({ tenantId: a.t, recommendationId: ra.recommendationId, actor: a.admin, action: "OVERRIDE", amount: "450" }), /FX Trade refused/);
    assert.deepEqual(await view(x.hr, a.t, ra.recommendationId), ["OPEN", ["200.00", "200.00", "200.00", "200.00", "200.00"], null], "a refusal puts the original, note-less split back");
  } finally { await x.done(); }
  const oa = await app.hedgeRecommendation.commands.decide({ tenantId: a.t, recommendationId: ra.recommendationId, actor: a.admin, action: "OVERRIDE", amount: "450" });
  assert.deepEqual([oa.parts.map((p) => p.amount)], [["200.00", "250.00"]]);
  assert.match(oa.splitNote!, /added to the part before it/);
  // The other way round: the original has a note (1,000 at 300 with a 109 minimum merges its last 100), and the override has none (450 is 300 and 150).
  const b = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER", minHedgeDisplay: "120" }));
  const rb = us01(b.recs);
  assert.deepEqual(rb.parts.map((p) => p.amount), ["300.00", "300.00", "400.00"]);
  assert.match(rb.splitNote!, /added to the part before it/);
  const y = refused();
  try {
    await assert.rejects(y.hr.commands.decide({ tenantId: b.t, recommendationId: rb.recommendationId, actor: b.admin, action: "OVERRIDE", amount: "450" }), /FX Trade refused/);
    const [status, parts, note] = await view(y.hr, b.t, rb.recommendationId);
    assert.deepEqual([status, parts], ["OPEN", ["300.00", "300.00", "400.00"]]);
    assert.match(note as string, /added to the part before it/, "the original note is back");
  } finally { await y.done(); }
  const ob = await app.hedgeRecommendation.commands.decide({ tenantId: b.t, recommendationId: rb.recommendationId, actor: b.admin, action: "OVERRIDE", amount: "450" });
  assert.deepEqual([ob.parts.map((p) => p.amount), ob.splitNote], [["300.00", "150.00"], null], "the note describes the parts that stand");
});

e2e("cancelled pre-trades reach the recommendation: one cancelled part leaves it open, cancelling every part cancels it, a part executed with the rest cancelled closes it out, and a cycle closed before approval cancels the drafts", async () => {
  const accept = async () => {
    const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }));
    const rec = us01(x.recs);
    await app.hedgeRecommendation.commands.decide({ tenantId: x.t, recommendationId: rec.recommendationId, actor: x.admin, action: "ACCEPT" });
    return { ...x, rec, parts: await drafts(x.t, x.cycle, rec.recommendationId) };
  };
  const now = async (x: { t: TenantId; rec: { recommendationId: string } }) => { const r = (await app.hedgeRecommendation.questions.getRecommendation(x.t, x.rec.recommendationId))!; return [r.followUp, r.parts.map((p) => p.followUp)]; };
  const cancel = async (x: { t: TenantId; admin: Actor }, id: string) => { const done = await app.fxTrade.commands.cancelPreTrade({ tenantId: x.t, preTradeId: id, actor: x.admin }); await drain(app); return done; };

  // Drafts: one cancelled part does not cancel the whole; cancelling every part does. Cancelling twice changes nothing.
  const a = await accept();
  assert.equal(await cancel(a, a.parts[0]!.preTradeId), true);
  assert.deepEqual(await now(a), ["OPEN", ["CANCELLED", "OPEN", "OPEN", "OPEN"]]);
  assert.equal(await cancel(a, a.parts[0]!.preTradeId), false);
  await cancel(a, a.parts[1]!.preTradeId); await cancel(a, a.parts[2]!.preTradeId);
  assert.deepEqual(await now(a), ["OPEN", ["CANCELLED", "CANCELLED", "CANCELLED", "OPEN"]], "one part is still live");
  await cancel(a, a.parts[3]!.preTradeId);
  assert.deepEqual(await now(a), ["CANCELLED", ["CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED"]]);
  assert.equal(await drain(app), 0, "nothing is left to deliver");

  // One part executed, the others cancelled: every part is finished, part of the hedge happened and the rest did not: closed out (decision 0017).
  const b = await accept();
  await app.exposureManagement.commands.approveCycle({ tenantId: b.t, cycleId: b.cycle, actor: b.admin });
  await drain(app);
  const sent = await app.fxTrade.commands.exportPreTrades({ tenantId: b.t, actor: b.admin });
  const [h, ...rows] = sent.file.trim().split("\n").map((l) => l.split(","));
  const out = Object.fromEntries(h!.map((k, i) => [k, rows.find((r) => r[h!.indexOf("deal_amount")] === "100.0000")![i]!]));
  const reply = [
    "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference",
    `SIM-7,SIMFX,${out.trading_entity},Sim Bank,2026-11-12,${out.value_date},${out.deal_currency},${out.deal_amount},${out.settlement_currency},110.0000,${out.instrument},${out.buy_sell},${out.hedging_program_id},${out.pre_trade_reference}`,
  ].join("\n");
  assert.equal((await app.fxTrade.commands.importExecutedTrades({ tenantId: b.t, rows: parseExecutedFile(reply), by: "simulator" })).matched, 1);
  await drain(app);
  for (const p of b.parts.filter((x) => x.legs[0]!.dealAmount !== "100.0000")) await cancel(b, p.preTradeId);
  assert.deepEqual(await now(b), ["EXECUTED_REST_CANCELLED", ["CANCELLED", "CANCELLED", "CANCELLED", "EXECUTED"]]);

  // A cycle closed before approval cancels its drafts, and so the recommendation's parts. The event is delivered to FX Trade as Exposure Management would
  // send it (skipping a cycle once its exposure is approved is refused by a database constraint there today; that is outside this change).
  const c = await accept();
  const closed = { type: "exposure-management.cycle-skipped", eventId: randomUUID(), occurredAt: new Date().toISOString(), tenantId: c.t, cycleId: c.cycle, programId: programId("BS") } as never;
  assert.equal(await app.fxTrade.commands.onCycleClosed(closed), 4);
  assert.equal(await app.fxTrade.commands.onCycleClosed(closed), 0, "the same event again changes nothing");
  await drain(app);
  assert.ok((await drafts(c.t, c.cycle, c.rec.recommendationId)).every((p) => p.status === "CANCELLED"));
  assert.deepEqual(await now(c), ["CANCELLED", ["CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED"]]);
});

e2e("a split decision that never got its pre-trades: approval confirms it when FX Trade holds every part, and lapses it when it holds none", async () => {
  const stuck = async () => {
    const x = await finishedCycle(split({ splitMethod: "EVEN" }));
    const rec = us01(x.recs);
    return { ...x, rec };
  };
  // FX Trade made the parts but the answer was lost: the decision stays recorded, then cycle approval settles it from what FX Trade holds.
  const a = await stuck();
  const lost = withFxTrade(async (input) => { await real(input); throw new Error("connection reset after commit"); }, true);
  try { await assert.rejects(lost.hr.commands.decide({ tenantId: a.t, recommendationId: a.rec.recommendationId, actor: a.admin, action: "ACCEPT" })); } finally { await lost.done(); }
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(a.t, a.rec.recommendationId))!.status, "DECIDING");
  await app.exposureManagement.commands.approveCycle({ tenantId: a.t, cycleId: a.cycle, actor: a.admin });
  await drain(app);
  const done = (await app.hedgeRecommendation.questions.getRecommendation(a.t, a.rec.recommendationId))!;
  assert.deepEqual([done.status, done.parts.every((p) => p.preTradeId !== null), done.parts.length], ["ACCEPTED", true, 4]);
  // Nothing was made: the decision lapses.
  const b = await stuck();
  const none = withFxTrade(async () => { throw new Error("FX Trade unreachable"); }, true);
  try { await assert.rejects(none.hr.commands.decide({ tenantId: b.t, recommendationId: b.rec.recommendationId, actor: b.admin, action: "ACCEPT" })); } finally { await none.done(); }
  await app.exposureManagement.commands.approveCycle({ tenantId: b.t, cycleId: b.cycle, actor: b.admin });
  await drain(app);
  assert.equal((await app.hedgeRecommendation.questions.getRecommendation(b.t, b.rec.recommendationId))!.status, "LAPSED");
  assert.deepEqual(await drafts(b.t, b.cycle, b.rec.recommendationId), []);
});

e2e("a pre-trade cancelled after FX Trade made it but before the recommendation linked it stays cancelled once the link is made", async () => {
  const run = async (cancelCount: number) => {
    const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }));
    const rec = us01(x.recs);
    const { hr, done } = withFxTrade(async (input) => {
      const made = await real(input);
      // The pause: the drafts exist, the recommendation has not linked them. Cancel some and deliver the events now; they find no linked part.
      for (const p of (await drafts(x.t, x.cycle, rec.recommendationId)).slice(0, cancelCount)) await app.fxTrade.commands.cancelPreTrade({ tenantId: x.t, preTradeId: p.preTradeId, actor: x.admin });
      await drain(app);
      const early = (await app.hedgeRecommendation.questions.getRecommendation(x.t, rec.recommendationId))!;
      assert.ok(early.parts.every((p) => p.preTradeId === null), "nothing linked yet, so the events changed nothing");
      return made;
    });
    try { await hr.commands.decide({ tenantId: x.t, recommendationId: rec.recommendationId, actor: x.admin, action: "ACCEPT" }); } finally { await done(); }
    await drain(app);
    const r = (await app.hedgeRecommendation.questions.getRecommendation(x.t, rec.recommendationId))!;
    return [r.status, r.followUp, r.parts.map((p) => p.followUp)];
  };
  assert.deepEqual(await run(1), ["ACCEPTED", "OPEN", ["CANCELLED", "OPEN", "OPEN", "OPEN"]]);
  assert.deepEqual(await run(4), ["ACCEPTED", "CANCELLED", ["CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED"]]);
});

e2e("a failed status read after confirmation does not undo the decision: the pre-trade-created event repairs the part on a later drain, with no second pre-trade or audit record", async () => {
  const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }));
  const rec = us01(x.recs);
  const { hr, done } = withFxTrade(async (input) => {
    const made = await real(input);
    const [first] = await drafts(x.t, x.cycle, rec.recommendationId);
    await app.fxTrade.commands.cancelPreTrade({ tenantId: x.t, preTradeId: first!.preTradeId, actor: x.admin }); // cancelled before it is linked
    await drain(app);
    return made;
  }, false, true); // and the status read right after confirmation fails
  try { await hr.commands.decide({ tenantId: x.t, recommendationId: rec.recommendationId, actor: x.admin, action: "ACCEPT" }); } finally { await done(); }
  const get = async () => (await app.hedgeRecommendation.questions.getRecommendation(x.t, rec.recommendationId))!;
  const stale = await get();
  assert.deepEqual([stale.status, stale.followUp, stale.parts.map((p) => p.followUp)], ["ACCEPTED", "OPEN", ["OPEN", "OPEN", "OPEN", "OPEN"]], "the decision stands; the part has not yet caught up");

  // The first delivery of the event fails its read: it is recorded and tried again a minute later.
  const qs = app.fxTrade.questions as unknown as { getPreTrade: (...a: never[]) => Promise<unknown> };
  const real_ = qs.getPreTrade;
  qs.getPreTrade = async () => { throw new Error("FX Trade status unavailable"); };
  const t0 = new Date();
  try { await drain(app, { now: t0 }); } finally { qs.getPreTrade = real_; }
  assert.deepEqual((await get()).parts.map((p) => p.followUp), ["OPEN", "OPEN", "OPEN", "OPEN"]);

  await drain(app, { now: new Date(t0.getTime() + 61_000) });
  const fixed = await get();
  assert.deepEqual([fixed.status, fixed.followUp, fixed.parts.map((p) => p.followUp)], ["ACCEPTED", "OPEN", ["CANCELLED", "OPEN", "OPEN", "OPEN"]]);
  assert.equal((await drafts(x.t, x.cycle, rec.recommendationId)).length, 4, "no second set of pre-trades");
  assert.equal((await trailOf(x.t)).filter((r) => r.action === "recommendation.accepted").length, 1, "one decision record");
  assert.equal(await drain(app), 0, "nothing is left pending");
});

e2e("an override that never got its pre-trades lapses with the cycle, and the original parts and note come back; no override is recorded", async () => {
  const unsure = () => withFxTrade(async () => { throw new Error("FX Trade unreachable"); }, true);
  const view = async (t: TenantId, id: string) => { const r = (await app.hedgeRecommendation.questions.getRecommendation(t, id))!; return [r.status, r.parts.map((p) => p.amount), r.splitNote, r.decidedAmount ?? null]; };
  const run = async (over: object, original: { parts: string[]; note: RegExp | null }) => {
    const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER", ...over }));
    const rec = us01(x.recs);
    assert.deepEqual(rec.parts.map((p) => p.amount), original.parts);
    const down = unsure();
    try { await assert.rejects(down.hr.commands.decide({ tenantId: x.t, recommendationId: rec.recommendationId, actor: x.admin, action: "OVERRIDE", amount: "450" })); } finally { await down.done(); }
    const [status, parts, note] = await view(x.t, rec.recommendationId);
    assert.equal(status, "DECIDING");
    assert.notDeepEqual(parts, original.parts, "the override re-split the amount");
    await app.exposureManagement.commands.approveCycle({ tenantId: x.t, cycleId: x.cycle, actor: x.admin });
    await drain(app);
    const [s2, p2, n2, d2] = await view(x.t, rec.recommendationId);
    assert.deepEqual([s2, p2, d2], ["LAPSED", original.parts, null]);
    if (original.note === null) assert.equal(n2, null); else assert.match(n2 as string, original.note);
    const got = (await app.hedgeRecommendation.questions.getRecommendation(x.t, rec.recommendationId))!;
    assert.equal(got.decidedBy ?? null, null);
    assert.equal((await trailOf(x.t)).filter((r) => r.action === "recommendation.overridden").length, 0, "no override record");
    assert.deepEqual(await drafts(x.t, x.cycle, rec.recommendationId), []);
  };
  // The override adds a note (merged remainder); the original had none.
  await run({ maxHedgeDisplay: "220", minHedgeDisplay: "110" }, { parts: ["200.00", "200.00", "200.00", "200.00", "200.00"], note: null });
  // The override drops the original's note; the lapse brings it back.
  await run({ minHedgeDisplay: "120" }, { parts: ["300.00", "300.00", "400.00"], note: /added to the part before it/ });
});

e2e("a part belongs to its recommendation's program, and a policy's overrides to the policy: the database refuses anything else (decision 0018)", async () => {
  const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER", ratioOverrides: [{ pair: "EUR-USD", ratio: "0.5" }] }));
  const rec = us01(x.recs);
  const db = connectHr(url!);
  const refused = async (statement: ReturnType<typeof sql>, why: string) => { await assert.rejects(statement.execute(db), { code: "23503" }, why); };
  try {
    await refused(sql`update hedge_recommendation.recommendation_parts set program_id = 'OTHER' where tenant_id = ${x.t} and recommendation_id = ${rec.recommendationId}`, "a part under another program");
    await refused(sql`update hedge_recommendation.recommendations set program_id = 'OTHER' where tenant_id = ${x.t} and recommendation_id = ${rec.recommendationId}`, "a recommendation moved from under its parts");
    await refused(sql`insert into hedge_recommendation.ratio_overrides (tenant_id, program_id, currency_pair, ratio) values (${x.t}, 'NOPE', 'EUR-USD', 1)`, "an override for a program with no policy");
    await refused(sql`insert into hedge_recommendation.rounding_overrides (tenant_id, program_id, currency, rounding) values (${x.t}, 'NOPE', 'EUR', 1)`, "a rounding override for a program with no policy");
    await refused(sql`insert into hedge_recommendation.max_hedge_overrides (tenant_id, program_id, netting_level, max_hedge_display) values (${x.t}, 'NOPE', 'ENTITY', 1)`, "a maximum override for a program with no policy");
  } finally { await db.destroy(); }
  // Saving a policy again replaces its overrides and the policy together.
  await app.hedgeRecommendation.commands.setPolicy({ tenantId: x.t, programId: programId("BS"), policy: { ...split({ ratioOverrides: [{ pair: "EUR-USD", ratio: "0.4" }] }) }, actor: x.admin } as never);
  assert.deepEqual((await app.hedgeRecommendation.questions.policy(x.t, programId("BS")))!.ratioOverrides, [{ pair: "EUR-USD", ratio: "0.4" }]);
});

e2e("an amendment that leaves a pre-trade puts the recommendation's follow-up back, and the valid rows in the same file still apply (decision 0018)", async () => {
  const x = await finishedCycle(split({ splitMethod: "THRESHOLD_REMAINDER" }));
  const rec = us01(x.recs);
  await app.hedgeRecommendation.commands.decide({ tenantId: x.t, recommendationId: rec.recommendationId, actor: x.admin, action: "ACCEPT" });
  await app.exposureManagement.commands.approveCycle({ tenantId: x.t, cycleId: x.cycle, actor: x.admin });
  await drain(app);
  const sent = await app.fxTrade.commands.exportPreTrades({ tenantId: x.t, actor: x.admin });
  const [h, ...rows] = sent.file.trim().split("\n").map((l) => l.split(","));
  const out = Object.fromEntries(h!.map((k, i) => [k, rows.find((r) => r[h!.indexOf("deal_amount")] === "100.0000")![i]!]));
  const header = "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,instrument,buy_sell,hedging_program_id,pre_trade_reference";
  const row = (id: string, program: string, settlement: string, reference: string) =>
    `${id},SIMFX,${out.trading_entity},Sim Bank,2026-11-12,${out.value_date},${out.deal_currency},${out.deal_amount},${out.settlement_currency},${settlement},${out.instrument},${out.buy_sell},${program},${reference}`;
  const file = (...r: string[]) => parseExecutedFile([header, ...r].join("\n"));
  const state = async () => { const r = (await app.hedgeRecommendation.questions.getRecommendation(x.t, rec.recommendationId))!; return [r.followUp, r.parts.map((p) => p.followUp)]; };

  assert.equal((await app.fxTrade.commands.importExecutedTrades({ tenantId: x.t, rows: file(row("SIM-7", out.hedging_program_id!, "110.0000", out.pre_trade_reference!)), by: "simulator" })).matched, 1);
  await drain(app);
  assert.deepEqual(await state(), ["PARTLY_EXECUTED", ["OPEN", "OPEN", "OPEN", "EXECUTED"]]);

  // The bank amends the trade and the program is blank. The row is stored unmatched, the other trade in the file is stored, nothing is rolled back.
  const amended = await app.fxTrade.commands.importExecutedTrades({ tenantId: x.t, by: "simulator",
    rows: file(row("SIM-7", "", "111.0000", out.pre_trade_reference!), row("SIM-8", out.hedging_program_id!, "5.0000", "")) });
  assert.deepEqual([amended.status, amended.stored, amended.matched], ["APPLIED", 2, 0]);
  await drain(app);
  assert.deepEqual(await state(), ["OPEN", ["OPEN", "OPEN", "OPEN", "OPEN"]], "the part lost its fill, so the recommendation is open again");
  assert.equal(await drain(app), 0, "and nothing is left to deliver");
});

e2e("deciders: accepting, overriding and a decision still waiting on FX Trade count; a refused claim and a dismissal do not", async () => {
  const label = async (t: TenantId) => (await trailOf(t)).find((r) => r.action === "program.defined")!.actor;
  const hedge = (recs: readonly { action: string; recommendationId: string }[]) => recs.find((r) => r.action === "HEDGE")!.recommendationId;

  const a = await finishedCycle(defaults);
  const stuck = withFxTrade(async () => { throw new Error("FX Trade unreachable"); });
  try { await assert.rejects(stuck.hr.commands.decide({ tenantId: a.t, recommendationId: hedge(a.recs), actor: a.admin, action: "ACCEPT" }), /unreachable/); } finally { await stuck.done(); }
  assert.deepEqual(await app.hedgeRecommendation.questions.deciders(a.t, a.cycle), [await label(a.t)], "waiting on FX Trade still counts");

  const b = await finishedCycle(defaults);
  const refused = withFxTrade(async () => { throw Object.assign(new Error("no"), { problems: ["not allowed"] }); });
  try { await assert.rejects(refused.hr.commands.decide({ tenantId: b.t, recommendationId: hedge(b.recs), actor: b.admin, action: "ACCEPT" }), /refused/); } finally { await refused.done(); }
  assert.deepEqual(await app.hedgeRecommendation.questions.deciders(b.t, b.cycle), [], "a refused claim reopened the recommendation");
  await app.hedgeRecommendation.commands.decide({ tenantId: b.t, recommendationId: hedge(b.recs), actor: b.admin, action: "DISMISS" });
  assert.deepEqual(await app.hedgeRecommendation.questions.deciders(b.t, b.cycle), [], "a dismissal does not count");

  const c = await finishedCycle(defaults);
  await app.hedgeRecommendation.commands.decide({ tenantId: c.t, recommendationId: hedge(c.recs), actor: c.admin, action: "OVERRIDE", amount: "300" });
  await drain(app);
  assert.deepEqual(await app.hedgeRecommendation.questions.deciders(c.t, c.cycle), [await label(c.t)]);
  assert.deepEqual(await app.hedgeRecommendation.questions.deciders(c.t, b.cycle), [], "another tenant's cycle ID finds nothing");
});

e2e("approval handshake across the real services: a reservation stops its approver winning a decision; a decision stops the reservation; a stale reservation is cleared when the cycle is approved", async () => {
  const { t, cycle, recs } = await finishedCycle(defaults, "ENTITY", false, true);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  const approver = async (): Promise<Actor> => ({ kind: "user", userId: (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_APPROVER"] }, ops)) as never });
  const [a, b] = [await approver(), await approver()];
  const name = (x: Actor) => `user:${(x as { userId: string }).userId}`;
  const hr = app.hedgeRecommendation;
  const rec = recs.find((r) => r.action === "HEDGE")!;
  await app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle as string, actor: a });
  await drain(app);

  // Reservation first: a's accept is refused and the recommendation stays open; releasing it lets a decide.
  const holdId = randomUUID();
  assert.deepEqual(await hr.commands.reserveApproval(t, cycle, name(a), holdId), { held: true });
  assert.deepEqual(await hr.commands.reserveApproval(t, cycle, name(a), holdId), { held: true }, "repeating the same reservation is safe");
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), [name(a)]);
  await assert.rejects(hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: a, action: "ACCEPT" }), /you are approving this cycle, so someone else must decide/);
  assert.equal((await hr.questions.getRecommendation(t, rec.recommendationId))!.status, "OPEN");
  await hr.commands.releaseApproval(t, holdId);
  await hr.commands.releaseApproval(t, holdId); // releasing twice is harmless
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), []);

  // Decision first: a wins the accept (so it counts at once, even before its pre-trade is confirmed elsewhere), and then cannot reserve or approve.
  await hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: a, action: "ACCEPT" });
  assert.deepEqual(await hr.commands.reserveApproval(t, cycle, name(a), randomUUID()), { held: false });
  await assert.rejects(app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: a }), /accepted or overrode/);
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), [], "the refused approval left nothing reserved");

  // b is not a decider, so b can reserve and approve. A reservation left behind by a crash is cleared once the cycle is approved.
  assert.deepEqual(await hr.commands.reserveApproval(t, cycle, name(b), randomUUID()), { held: true });
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: b });
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), [name(b)], "the stale reservation is still there until the cycle's approval reaches Hedge Recommendation");
  await drain(app);
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), []);
});

e2e("approval handshake: an accept and a reservation by the same person, submitted together, are never both won", async () => {
  const outcomes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { t, cycle, recs } = await finishedCycle(defaults, "ENTITY", false, true);
    const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
    const a: Actor = { kind: "user", userId: (await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_APPROVER"] }, ops)) as never };
    await app.exposureManagement.commands.approveExposure({ tenantId: t, cycleId: cycle as string, actor: a });
    await drain(app);
    const rec = recs.find((r) => r.action === "HEDGE")!;
    const hr = app.hedgeRecommendation;
    const [decision, reservation] = await Promise.all([
      hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: a, action: "ACCEPT" }).then(() => true, () => false),
      hr.commands.reserveApproval(t, cycle, `user:${(a as { userId: string }).userId}`, randomUUID()).then((r) => r.held),
    ]);
    assert.equal(decision && reservation, false, "one person won both");
    assert.equal(decision || reservation, true, "and one of them did win");
    outcomes.push(decision ? "decision" : "reservation");
  }
  assert.equal(outcomes.length, 3);
});

e2e("an interrupted approval strands its holder's hedge decisions; recovery lets the team decide on the same cycle, and is audited", async () => {
  const { t, admin, cycle, recs } = await finishedCycle(defaults, "ENTITY", false, true);
  const hr = app.hedgeRecommendation;
  const rec = recs.find((r) => r.action === "HEDGE")!;
  const me = (await trailOf(t)).find((r) => r.action === "program.defined")!.actor; // the admin's label; a one-person team
  await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: admin });
  await approveExposure(t, cycle as string);
  await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: true, actor: admin });

  // An Approve Cycle whose process dies right after reserving: a second Exposure Management over the same database, with the real calls but a crash after reserve and no release.
  const dyingDb = connectEm(url!);
  const dying = createExposureManagement(dyingDb, {
    access: app.identity.questions,
    decisions: {
      reserveApproval: async (tenant, c, approver, id) => { await hr.commands.reserveApproval(tenant, c, approver, id); throw new Error("process died"); },
      releaseApproval: async () => { throw new Error("unreachable"); },
    },
    now: () => clock.now,
  });
  await assert.rejects(dying.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin }), /process died/);
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), [me]);
  await assert.rejects(hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /you are approving this cycle/);
  // Turning the policy off does not free the holder.
  await app.exposureManagement.commands.setSegregationOfDuties({ tenantId: t, enabled: false, actor: admin });
  await assert.rejects(hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" }), /you are approving this cycle/);

  // Recovery: stops the attempt, releases the reservation; the same person can now decide on the same open cycle, and approve it.
  assert.equal(await app.exposureManagement.commands.recoverApproval({ tenantId: t, cycleId: cycle as string, actor: admin }), 1);
  assert.deepEqual(await hr.questions.approvalHolds(t, cycle), []);
  assert.equal(await app.exposureManagement.commands.recoverApproval({ tenantId: t, cycleId: cycle as string, actor: admin }), 0, "repeating it is harmless");
  await hr.commands.decide({ tenantId: t, recommendationId: rec.recommendationId, actor: admin, action: "ACCEPT" });
  await app.exposureManagement.commands.approveCycle({ tenantId: t, cycleId: cycle as string, actor: admin });
  await drain(app);
  assert.ok((await app.exposureManagement.questions.getCycle(t, cycle))!.approvedAt);
  assert.equal((await trailOf(t, { action: "cycle.approval-recovered" })).length, 1, "one recovery recorded");
  await dyingDb.destroy();
});


const loadCalendars = (t: TenantId, rows: { currencyCode: string; weekendDays: ("SAT" | "SUN")[]; coveredThrough: string; holidays: { date: string; name: string | null }[] }[]) =>
  app.masterData.commands.applyCalendars({ tenantId: t, sourceSystem: "manual", asOf: asOfDate("2026-01-01"), mode: "PARTIAL", rows, by: "test" });

e2e("value dates follow the pair's business-day calendars; a currency without a calendar, or one that ends too early, is flagged", async () => {
  // The cycle's as-of date is the 11th; plus one month is Friday 11 December 2026, a business day. With no calendars it stays, and both currencies are flagged.
  const bare = await finishedCycle();
  const rec = bare.recs.find((r) => r.action === "HEDGE")!;
  assert.deepEqual([rec.valueDate, rec.calendarGaps], ["2026-12-11", [{ currency: "EUR", reason: "NO_CALENDAR" }, { currency: "USD", reason: "NO_CALENDAR" }]]);
  assert.deepEqual(bare.recs.find((r) => r.action === "NONE")!.calendarGaps, [], "a group with no trade has no dates to doubt");

  // USD is closed on the 11th and EUR on the 14th (the 12th and 13th are a weekend): the first day open in both is the 15th. The holiday of either currency counts, both calendars cover it, so nothing is flagged.
  const full = await finishedCycle(undefined, "ENTITY", true, false, (t) => loadCalendars(t, [
    { currencyCode: "USD", weekendDays: ["SAT", "SUN"], coveredThrough: "2026-12-31", holidays: [{ date: "2026-12-11", name: "test holiday" }] },
    { currencyCode: "EUR", weekendDays: ["SAT", "SUN"], coveredThrough: "2026-12-31", holidays: [{ date: "2026-12-14", name: null }] },
  ]));
  const fullRec = full.recs.find((r) => r.action === "HEDGE")!;
  assert.deepEqual([fullRec.valueDate, fullRec.calendarGaps], ["2026-12-15", []]);

  // USD's holidays are known only to 1 December: the value date is judged on what is there and the gap says USD could not be fully trusted.
  const short = await finishedCycle(undefined, "ENTITY", true, false, (t) => loadCalendars(t, [
    { currencyCode: "USD", weekendDays: ["SAT", "SUN"], coveredThrough: "2026-12-01", holidays: [] },
    { currencyCode: "EUR", weekendDays: ["SAT", "SUN"], coveredThrough: "2026-12-31", holidays: [] },
  ]));
  const shortRec = short.recs.find((r) => r.action === "HEDGE")!;
  assert.deepEqual([shortRec.valueDate, shortRec.calendarGaps], ["2026-12-11", [{ currency: "USD", reason: "CALENDAR_ENDED" }]]);

  // An expired calendar with a Friday/Saturday weekend, known to Thursday 10 December: the 11th is after the cover, so it falls back to Saturday/Sunday and
  // Friday the 11th stays a business day (trusting the expired weekend would roll it to Monday the 14th). The warning stays.
  const gulf = await finishedCycle(undefined, "ENTITY", true, false, (t) => loadCalendars(t, [
    { currencyCode: "USD", weekendDays: ["FRI", "SAT"] as never, coveredThrough: "2026-12-10", holidays: [] },
    { currencyCode: "EUR", weekendDays: ["SAT", "SUN"], coveredThrough: "2026-12-31", holidays: [] },
  ]));
  const gulfRec = gulf.recs.find((r) => r.action === "HEDGE")!;
  assert.deepEqual([gulfRec.valueDate, gulfRec.calendarGaps], ["2026-12-11", [{ currency: "USD", reason: "CALENDAR_ENDED" }]]);
});

e2e("a failed delivery is retried 1, 2, 4, 8 minutes later, then stuck; it holds only its own tenant's later events, and an operator can retry it", async () => {
  const a = await tenantWithProgram();
  const b = await tenantWithProgram();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const raw = async (tenant: TenantId) => {
    const id = randomUUID();
    await client.query("INSERT INTO fx_rate.outbox (event_id, tenant_id, type, payload) VALUES ($1, $2, 'fx-rate.loaded', $3)", [id, tenant, JSON.stringify({ type: "fx-rate.loaded", tenantId: tenant, eventId: id, occurredAt: new Date().toISOString() })]);
    return id;
  };
  const cmds = app.exposureAnalysis.commands as unknown as { retryWaiting: (t: TenantId) => Promise<unknown> };
  const real = cmds.retryWaiting;
  const calls: string[] = [];
  let broken = true;
  cmds.retryWaiting = async (tenant) => { calls.push(tenant); if (tenant === a && broken) throw new Error("analysis unavailable"); };
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const min = 60_000;
  const t0 = new Date("2030-01-01T00:00:00Z");
  try {
    const first = await raw(a);
    const behind = await raw(a); // announced after the failing one, same tenant
    const other = await raw(b);
    assert.equal(await drain(app, { now: t0 }), 1, "the other tenant's event is delivered; nothing throws");
    assert.deepEqual(calls.filter((c) => c === a), [a], "only the first event was tried; the one behind it waited");
    const after1 = (await deliveryProblems(app)).filter((p) => p.tenantId === a);
    assert.deepEqual(after1.map((p) => [p.eventId, p.attempts, p.lastError, p.stuckAt]), [[first, 1, "analysis unavailable", null]]);
    assert.equal(after1[0]!.retryAt!.getTime(), at(1 * min).getTime());

    await drain(app, { now: at(30_000) });
    assert.equal(calls.filter((c) => c === a).length, 1, "not tried before its time");
    await drain(app, { now: at(1 * min) }); // 2nd failure: wait 2 minutes
    assert.equal((await deliveryProblems(app)).find((p) => p.eventId === first)!.retryAt!.getTime(), at(3 * min).getTime());
    await drain(app, { now: at(3 * min - 1) });
    assert.equal(calls.filter((c) => c === a).length, 2);
    await drain(app, { now: at(3 * min) }); // 3rd: wait 4
    assert.equal((await deliveryProblems(app)).find((p) => p.eventId === first)!.retryAt!.getTime(), at(7 * min).getTime());
    await drain(app, { now: at(7 * min) }); // 4th: wait 8
    assert.equal((await deliveryProblems(app)).find((p) => p.eventId === first)!.retryAt!.getTime(), at(15 * min).getTime());
    await drain(app, { now: at(15 * min) }); // 5th: stuck
    const stuck = (await deliveryProblems(app)).filter((p) => p.tenantId === a);
    assert.deepEqual(stuck.map((p) => [p.eventId, p.attempts, p.lastError, p.retryAt, p.stuckAt?.getTime()]), [[first, 5, "analysis unavailable", null, at(15 * min).getTime()]]);
    const tries = calls.filter((c) => c === a).length;
    assert.equal(tries, 5);
    await drain(app, { now: at(600 * min) });
    assert.equal(calls.filter((c) => c === a).length, tries, "a stuck event is not tried again by itself");

    assert.equal(await retryStuckEvent(app, "fx-rate", behind), false, "only a stuck event can be retried");
    broken = false;
    assert.equal(await retryStuckEvent(app, "fx-rate", first), true);
    assert.equal(await drain(app, { now: at(601 * min) }), 2, "the retried event and the one that waited behind it, in order");
    assert.deepEqual((await deliveryProblems(app)).filter((p) => p.tenantId === a), []);
    void other;
  } finally {
    cmds.retryWaiting = real;
    await client.end();
  }
});

e2e("a failure is persisted whole: an interrupted recording cannot leave an event eligible, a fifth failure never leads to a sixth delivery, and earlier failures keep their wait", async () => {
  const tenant = await app.identity.commands.createTenant("Acme");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("INSERT INTO fx_rate.outbox (event_id, tenant_id, type, payload) VALUES ($1, $2, 'fx-rate.loaded', $3)", [id, tenant, JSON.stringify({ type: "fx-rate.loaded", tenantId: tenant, eventId: id, occurredAt: new Date().toISOString() })]);
    // The old two-step write, stopped after its first step, would leave a counted failure with no wait and not stuck. The database refuses that state.
    await assert.rejects(client.query("UPDATE fx_rate.outbox SET attempts = attempts + 1 WHERE event_id = $1", [id]), /outbox_failure_state/);
    const state = async () => (await client.query("SELECT attempts, retry_at, stuck_at FROM fx_rate.outbox WHERE event_id = $1", [id])).rows[0] as { attempts: number; retry_at: Date | null; stuck_at: Date | null };
    const t0 = new Date("2031-01-01T00:00:00Z");
    for (let n = 1; n <= 5; n++) {
      const outcome = await app.fxRate.outbox.recordFailure(id, "boom", t0, RETRY_POLICY);
      const s = await state(); // read straight from the table: nothing else has run since the one statement
      assert.equal(s.attempts, n);
      if (n < 5) {
        assert.equal(outcome, "RETRYING");
        assert.equal(s.retry_at!.getTime(), t0.getTime() + 60_000 * 2 ** (n - 1), `failure ${n} keeps its wait`);
        assert.equal(s.stuck_at, null);
        assert.equal((await app.fxRate.outbox.pending(200, t0)).some((e) => (e as unknown as { eventId: string }).eventId === id), false, "not eligible at once");
      } else {
        assert.equal(outcome, "STUCK");
        assert.deepEqual([s.retry_at, s.stuck_at?.getTime()], [null, t0.getTime()]);
      }
    }
    const later = new Date(t0.getTime() + 365 * 24 * 3_600_000);
    assert.equal((await app.fxRate.outbox.pending(200, later)).some((e) => (e as unknown as { eventId: string }).eventId === id), false, "a persisted fifth failure is never delivered a sixth time");
  } finally {
    await client.end();
  }
});

e2e("the wait after a failure starts when the delivery failed, not when the drain began", async () => {
  const tenant = await app.identity.commands.createTenant("Acme");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const cmds = app.exposureAnalysis.commands as unknown as { retryWaiting: (t: TenantId) => Promise<unknown> };
  const real = cmds.retryWaiting;
  const t0 = new Date("2032-01-01T00:00:00Z").getTime();
  let current = t0;
  cmds.retryWaiting = async () => { current += 70_000; throw new Error("slow failure"); }; // the handler takes 70 seconds to fail
  try {
    const id = randomUUID();
    await client.query("INSERT INTO fx_rate.outbox (event_id, tenant_id, type, payload) VALUES ($1, $2, 'fx-rate.loaded', $3)", [id, tenant, JSON.stringify({ type: "fx-rate.loaded", tenantId: tenant, eventId: id, occurredAt: new Date(t0).toISOString() })]);
    await drain(app, { now: () => new Date(current) });
    const failedAt = t0 + 70_000;
    const problem = (await deliveryProblems(app)).find((p) => p.eventId === id)!;
    assert.equal(problem.retryAt!.getTime(), failedAt + 60_000, "the minute runs from the failure");
    const eligible = async (ms: number) => (await app.fxRate.outbox.pending(200, new Date(ms))).some((e) => (e as unknown as { eventId: string }).eventId === id);
    assert.equal(await eligible(failedAt + 59_000), false);
    assert.equal(await eligible(failedAt + 60_000), true);
    await client.query("UPDATE fx_rate.outbox SET published_at = now() WHERE event_id = $1", [id]); // leave nothing pending for later tests
  } finally {
    cmds.retryWaiting = real;
    await client.end();
  }
});

const amt = (over: object) => ({ ...defaults, roundingDefault: "10", strategy: "amount-threshold", amountThresholdDisplay: "1000", ...over });
const groupOf = (recs: readonly { entityCode: string | null }[], code: string) => recs.find((r) => r.entityCode === code) as Awaited<ReturnType<typeof finishedCycle>>["recs"][number];

e2e("amount threshold: a net exposure larger than the threshold is hedged in full, a level's own threshold replaces the program's, and rounding, the minimum and the split are the shared rules", async () => {
  // US01 holds 1,000 EUR, which is 1,100 USD at 1.1: above a 1,000 USD threshold (909.0909 EUR). DE01 holds 550 USD, within it.
  const run = await finishedCycle(amt({}));
  const us = groupOf(run.recs, "US01");
  assert.deepEqual([us.strategy, us.action, us.direction, us.amount, us.ratio, us.thresholdExposureAmount, us.neededAmount, us.targetHedge, us.parts.map((p) => p.amount)],
    ["amount-threshold", "HEDGE", "SELL", "1000.00", null, "909.0909", "-1000.00", "-1000.00", ["1000.00"]]);
  const de = groupOf(run.recs, "DE01");
  assert.deepEqual([de.action, de.reason, de.thresholdExposureAmount, de.ratio], ["NONE", "WITHIN_THRESHOLD", "1000.00", null]);
  // The recommendation can be decided like any other: accepting it makes a pre-trade for the full amount.
  const accepted = await app.hedgeRecommendation.commands.decide({ tenantId: run.t, recommendationId: us.recommendationId, actor: run.admin, action: "ACCEPT" });
  assert.equal((await app.fxTrade.questions.getPreTrade(run.t, accepted.preTradeId!))!.legs[0]!.dealAmount, "1000.0000");

  // A net exactly at the threshold is hedged (1,100 USD is exactly 1,000 EUR); one cent of threshold more and it is within.
  assert.deepEqual([groupOf((await finishedCycle(amt({ amountThresholdDisplay: "1100" }))).recs, "US01").action, groupOf((await finishedCycle(amt({ amountThresholdDisplay: "1100" }))).recs, "US01").amount], ["HEDGE", "1000.00"]);
  assert.equal(groupOf((await finishedCycle(amt({ amountThresholdDisplay: "1100.01" }))).recs, "US01").reason, "WITHIN_THRESHOLD");
  // The comparison uses the converted threshold, not its four-place display. At a rate of 3, 3,000.0001 USD is 1,000.0000333 EUR (shown as 1,000.00): the net of
  // 1,000 EUR is below it. 2,999.9999 USD is 999.99996667 EUR (also shown as 1,000.00): the net is above it.
  const above = groupOf((await finishedCycle(amt({ amountThresholdDisplay: "3000.0001" }), "ENTITY", true, false, undefined, "3")).recs, "US01");
  assert.deepEqual([above.action, above.reason, above.thresholdExposureAmount], ["NONE", "WITHIN_THRESHOLD", "1000.00"]);
  const under = groupOf((await finishedCycle(amt({ amountThresholdDisplay: "2999.9999" }), "ENTITY", true, false, undefined, "3")).recs, "US01");
  assert.deepEqual([under.action, under.amount, under.thresholdExposureAmount], ["HEDGE", "1000.00", "1000.00"]);

  // Levels: the cycle runs at ENTITY, so that level's override (1,101 USD) replaces the program's 100 USD, which would hedge both groups; another level's does not matter.
  const low = await finishedCycle(amt({ amountThresholdDisplay: "100" }));
  assert.deepEqual([groupOf(low.recs, "US01").action, groupOf(low.recs, "DE01").action, groupOf(low.recs, "DE01").amount], ["HEDGE", "HEDGE", "550.00"]);
  const lvl = (await finishedCycle(amt({ amountThresholdDisplay: "100", amountThresholdOverrides: [{ nettingLevel: "ENTITY", amountThresholdDisplay: "1101" }, { nettingLevel: "REGION", amountThresholdDisplay: "1" }] }))).recs;
  assert.deepEqual([groupOf(lvl, "US01").reason, groupOf(lvl, "DE01").reason, groupOf(lvl, "DE01").thresholdExposureAmount], ["WITHIN_THRESHOLD", "WITHIN_THRESHOLD", "1101.00"]);

  // Shared rules: rounding to the step (900 of 1,000), then the minimum (1,200 USD is 1,090.9091 EUR), then the split of an amount above the maximum.
  assert.equal(groupOf((await finishedCycle(amt({ roundingDefault: "300" }))).recs, "US01").amount, "900.00");
  const min = groupOf((await finishedCycle(amt({ minHedgeDisplay: "1200" }))).recs, "US01");
  assert.deepEqual([min.action, min.reason, min.minExposureAmount], ["NONE", "BELOW_MINIMUM", "1090.9091"]);
  const even = groupOf((await finishedCycle(amt({ maxHedgeDisplay: "330", splitMethod: "EVEN" }))).recs, "US01");
  assert.deepEqual([even.amount, even.maxExposureAmount, even.parts.map((p) => p.amount)], ["1000.00", "300.00", ["250.00", "250.00", "250.00", "250.00"]]);
  const rem = groupOf((await finishedCycle(amt({ maxHedgeDisplay: "330", splitMethod: "THRESHOLD_REMAINDER" }))).recs, "US01");
  assert.deepEqual(rem.parts.map((p) => p.amount), ["300.00", "300.00", "300.00", "100.00"]);

  // The ratio strategy is unchanged and records no threshold.
  const ratio = groupOf((await finishedCycle(defaults)).recs, "US01");
  assert.deepEqual([ratio.strategy, ratio.ratio, ratio.thresholdExposureAmount], ["hedge-ratio-adjustment", "1", null]);

  // Saved and read back; the strategy needs its threshold, and the database refuses a row without one.
  const saved = await finishedCycle(amt({ amountThresholdOverrides: [{ nettingLevel: "ENTITY", amountThresholdDisplay: "1100" }] }));
  const pol = await app.hedgeRecommendation.questions.policy(saved.t, programId("BS"));
  assert.deepEqual([pol.strategy, pol.amountThresholdDisplay, pol.amountThresholdOverrides], ["amount-threshold", "1000.00", [{ nettingLevel: "ENTITY", amountThresholdDisplay: "1100.00" }]]);
  await assert.rejects(app.hedgeRecommendation.commands.setPolicy({ tenantId: saved.t, programId: programId("BS"), actor: saved.admin, policy: { ...defaults, strategy: "amount-threshold" } as never }), /needs an amount threshold/);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assert.rejects(client.query("UPDATE hedge_recommendation.policies SET amount_threshold_display = NULL WHERE tenant_id = $1", [saved.t]), /policies_threshold_for_strategy/);
  } finally {
    await client.end();
  }
});

e2e("the policy is read from one snapshot: a save committed in the middle of a read is not half seen", async () => {
  const t = await tenantWithProgram();
  const admin = admins.get(t)!;
  const save = (policy: object) => app.hedgeRecommendation.commands.setPolicy({ tenantId: t, programId: programId("BS"), actor: admin, policy: policy as never });
  // Old: default 500 with a level override of 2,000 (nothing to hedge at that level). New: default 2,000 and no override. The two together never mean "hedge".
  await save(amt({ amountThresholdDisplay: "500", amountThresholdOverrides: [{ nettingLevel: "ENTITY", amountThresholdDisplay: "2000" }] }));
  let fired = false;
  const kinds = new Map<string, string>();
  const hook: KyselyPlugin = {
    transformQuery: (args) => { kinds.set(args.queryId.queryId, args.node.kind); return args.node; },
    async transformResult(args) {
      if (!fired && kinds.get(args.queryId.queryId) === "SelectQueryNode") { fired = true; await save(amt({ amountThresholdDisplay: "2000", amountThresholdOverrides: [] })); } // another save commits after the first read
      return args.result;
    },
  };
  const db = connectHr(url!).withPlugin(hook);
  try {
    const seen = await readPolicy(db, t, programId("BS"));
    assert.equal(fired, true);
    assert.deepEqual([seen.amountThresholdDisplay, seen.amountThresholdOverrides], ["500.00", [{ nettingLevel: "ENTITY", amountThresholdDisplay: "2000.00" }]], "the old policy whole, not its default with the new overrides");
    const now = await app.hedgeRecommendation.questions.policy(t, programId("BS"));
    assert.deepEqual([now.amountThresholdDisplay, now.amountThresholdOverrides], ["2000.00", []], "a read after the save sees the new policy");
  } finally {
    await db.destroy();
  }
});
