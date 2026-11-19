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
import { parseExecutedFile } from "../../services/fx-trade/src/index.ts";
import { drain, startDueCycles } from "./dispatch.ts";

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
  for (const s of ["identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade"]) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
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
async function tenantWithProgram(): Promise<TenantId> {
  const t = await app.identity.commands.createTenant("Acme");
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  await app.identity.commands.enableProgram(t, programId("BS"), ops);
  const adminId = await app.identity.commands.addUser(t, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ADMIN"] }, ops);
  admins.set(t, { kind: "user", userId: adminId });
  await app.exposureManagement.commands.defineProgram({
    tenantId: t, programId: "BS", name: "Daily balance sheet", type: "BALANCE_SHEET", effectiveFrom: "2026-01-01", actor: admins.get(t)!,
    settings: { nettingLevel: "ENTITY", bucketScheme: { kind: "MONTHS" }, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } },
  });
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
  assert.deepEqual(run2.hedgeCounts, { trades: 1, openLegs: 1, used: 1, noEntity: 0 });
  const all = await app.exposureAnalysis.questions.netExposures(t, run2.runId);
  const eur = all.find((g) => g.currencyPair === "EUR-USD" && g.entityCode === "US01")!;
  assert.equal(eur.hedges.exposureAmount, "-1000.00");
  assert.deepEqual([eur.gross.exposureAmount, eur.net.exposureAmount], ["1000.00", "0.00"]);
});
