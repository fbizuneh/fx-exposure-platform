// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// exposure_analysis schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, accountId, cycleId, entityId, lineageRef, programId, tenantId, type CycleId, type TenantId } from "@shared/kernel";
import type { IncludedBalance, IngestionStatus } from "@services/data-source/contract";
import type { Cycle } from "@services/exposure-management/contract";
import type { Rate } from "@services/fx-rate/contract";
import type { ExecutedTrade } from "@services/fx-trade/contract";
import type { Account, Entity } from "@services/master-data/contract";
import { migrate } from "../../../scripts/migrate.mjs";
import { connect, createExposureAnalysis, type Db } from "./index.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("exposure analysis database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

const AS_OF = "2026-11-09";
interface World {
  balances: IncludedBalance[];
  blocked: number;
  rates: Map<string, Pick<Rate, "rate" | "quality">>;
  cycles: Map<string, Cycle>;
  ndf: string[];
  /** When true the rate service throws, as if it were unreachable. */
  down?: boolean;
  /** Executed trades FX Trade would return. */
  trades?: ExecutedTrade[];
}
const worlds = new Map<string, World>();
const world = (t: string): World => worlds.get(t)!;

const ent = (code: string, over: Partial<Entity> = {}): Entity => ({
  entityId: entityId(`id-${code}`), code, name: code, type: "LEGAL_ENTITY", parentEntityId: null, countryCode: null, functionalCurrency: "USD",
  isLegalEntity: true, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over,
});
const ENTITIES = new Map([
  ent("US01", { parentEntityId: entityId("id-AMER") }), ent("DE01", { functionalCurrency: "EUR", parentEntityId: entityId("id-EMEA") }), ent("LOOSE"),
  ent("AMER", { type: "REGION", isLegalEntity: false }), ent("EMEA", { type: "REGION", isLegalEntity: false }),
].map((e) => [e.code, e]));
const ACCOUNTS = new Map(["4000", "9000"].map((n) => [n, { accountId: accountId(`a-${n}`), chartCode: "C", accountNumber: n, name: n, statementType: "BALANCE_SHEET", normalBalance: "DEBIT", monetaryFlag: n === "4000", fxRelevantFlag: true, hierarchyNodeCode: null } as Account]));

const fakes = {
  management: { async getCycle(t: TenantId, c: CycleId) { return world(t).cycles.get(c) ?? null; } },
  dataSource: {
    async includedBalances(query: { tenantId: TenantId }) { return world(query.tenantId).balances; },
    async ingestionStatus(t: TenantId): Promise<IngestionStatus[]> {
      const b = world(t).blocked;
      return [{ batchId: "b1", sourceSystem: "ERP", asOf: asOfDate(AS_OF), status: "COMPLETED_WITH_ISSUES", current: true, received: 10, included: 5, excluded: 0, blocked: b, failureReason: null, receivedAt: "2026-11-09T00:00:00Z" },
        { batchId: "b0", sourceSystem: "ERP", asOf: asOfDate(AS_OF), status: "COMPLETED", current: false, received: 1, included: 1, excluded: 0, blocked: 99, failureReason: null, receivedAt: "2026-11-08T00:00:00Z" }];
    },
  },
  masterData: {
    async getEntities(_t: TenantId, codes: readonly string[]) { return codes.flatMap((c) => (ENTITIES.has(c) ? [ENTITIES.get(c)!] : [])); },
    async getAccounts(_t: TenantId, keys: readonly { accountNumber: string }[]) { return keys.flatMap((k) => (ACCOUNTS.has(k.accountNumber) ? [ACCOUNTS.get(k.accountNumber)!] : [])); },
    async getCurrencies(t: TenantId) { return world(t).ndf.map((code) => ({ code, isNdf: true })); },
    async entityWalk(_t: TenantId, id: string) {
      const parent = [...ENTITIES.values()].find((e) => e.entityId === id)?.parentEntityId;
      return parent ? [...ENTITIES.values()].filter((e) => e.entityId === parent) : [];
    },
  },
  trades: {
    async executedTrades(tenant: TenantId): Promise<readonly ExecutedTrade[]> {
      return world(tenant).trades ?? [];
    },
  },
  rates: {
    async getRate(query: { tenantId: TenantId; base: string; quote: string }): Promise<Rate | null> {
      if (world(query.tenantId).down) throw new Error("fx-rate unavailable");
      const r = world(query.tenantId).rates.get(`${query.base}|${query.quote}`);
      return r ? { base: query.base, quote: query.quote, tenor: "SPOT", asOf: asOfDate(AS_OF), rate: r.rate, derivation: "DIRECT", quality: r.quality, source: "ECB", loadIds: ["load-1"] } : null;
    },
  },
};

let db: Db;
let ea: ReturnType<typeof createExposureAnalysis>;
const clock = new Date("2026-11-09T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("exposure_analysis").ifExists().cascade().execute();
  await migrate(url!);
  ea = createExposureAnalysis(db, { ...fakes, now: () => clock });
});
after(async () => {
  if (enabled) await db.destroy();
});

let seq = 0;
const bal = (entityCode: string, accountNumber: string, currency: string, amount: string): IncludedBalance => ({
  lineage: lineageRef("ERP", "b1", `rec-${++seq}`), programId: programId("BS"), asOf: asOfDate(AS_OF), entityId: entityId(`id-${entityCode}`), entityCode, accountId: accountId(`a-${accountNumber}`),
  chartCode: "C", accountNumber, currency, amount, dimensions: { dept: "10" },
});
const settings = (level = "GROUP_NATURAL", display = "USD", overrides: { pair: string; exposureCurrency: string }[] = []) => ({ programId: programId("BS"), type: "BALANCE_SHEET", nettingLevel: level, displayCurrency: display, exposureCurrencyOverrides: overrides, bucketScheme: { kind: "MONTHS" }, schedule: null, validFrom: asOfDate("2026-01-01") }) as Cycle["settings"];

/** A tenant with a program, a cycle in INITIATED, balances and rates. */
function setup(over: Partial<World> = {}, level = "GROUP_NATURAL", overrides: { pair: string; exposureCurrency: string }[] = []) {
  const t = tenantId(randomUUID());
  const c = cycleId(randomUUID());
  const w: World = {
    balances: [bal("US01", "4000", "EUR", "1000"), bal("DE01", "4000", "USD", "550"), bal("US01", "4000", "USD", "70"), bal("LOOSE", "4000", "GBP", "5"), bal("US01", "9000", "EUR", "9")],
    blocked: 3, rates: new Map([["EUR|USD", { rate: "1.1", quality: "VALID" }], ["GBP|USD", { rate: "1.25", quality: "VALID" }]]), cycles: new Map(), ndf: [], ...over,
  };
  w.cycles.set(c, { cycleId: c, programId: programId("BS"), asOf: asOfDate(AS_OF), stage: "INITIATED", outcome: null, outcomeReason: null, rerunCount: 0, approvedAt: null, approvedBy: null,
    initiatedBy: "user:1", initiatedAt: "2026-11-09T00:00:00Z", settings: settings(level, "USD", overrides), history: [] });
  worlds.set(t, w);
  return { t, c, w, event: () => ({ eventId: randomUUID(), tenantId: t, cycleId: c }) };
}
const events = async (t: TenantId) => (await ea.outbox.pending(1000)).filter((e) => e.tenantId === t);

dbTest("a run with everything it needs finishes, saves its evidence and announces started then finished with the run ID", async () => {
  const { t, c, event } = setup();
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual([run.status, run.waitReason, run.nettingLevel, run.displayCurrency, run.blockedBalances, run.frozenAt], ["FINISHED", null, "GROUP_NATURAL", "USD", 3, null]);
  // 5 received: LOOSE (GBP in USD functional, kept), US01 9000 not monetary, US01 USD in functional currency, DE01 USD kept, US01 EUR kept
  assert.deepEqual(run.counts, { received: 5, kept: 3, notLegalEntity: 0, accountNotInScope: 1, functionalCurrency: 1, noFunctionalCurrency: 0 });
  const ev = await events(t);
  assert.deepEqual(ev.map((e) => e.type), ["exposure-analysis.run-started", "exposure-analysis.run-finished"]);
  assert.ok(ev.every((e) => "runId" in e && e.runId === run.runId && e.cycleId === c));
  assert.deepEqual(Object.keys(ev[0]!).sort(), ["cycleId", "eventId", "occurredAt", "programId", "runId", "tenantId", "type"]);
  const groups = await ea.questions.exposures(t, run.runId);
  assert.deepEqual(groups.map((g) => [g.currencyPair, g.net1, g.net2, g.displayAmount, g.exposureCurrency]), [["EUR-USD", "500.00", "-550.00", "550.00", "EUR"], ["GBP-USD", "5.00", "-6.25", "6.25", "GBP"]]);
  const rows = await ea.questions.drilldown(t, run.runId, groups[0]!.groupNo);
  assert.deepEqual(rows.map((r) => [r.entityCode, r.region, r.transactionCurrency, r.amount, r.amount1, r.amount2, r.lineage.recordId.startsWith("rec-")]), [
    ["US01", "AMER", "EUR", "1000.00", "1000.00", "-1100.00", true], ["DE01", "EMEA", "USD", "550.00", "-500.00", "550.00", true]]);
  assert.deepEqual(rows[0]!.dimensions, { dept: "10" });
  assert.deepEqual((await ea.questions.ratesUsed(t, run.runId)).map((r) => `${r.base}-${r.quote}:${r.purpose}:${r.rate}:${r.quality}`), ["EUR-USD:DISPLAY:1.1000000000:VALID", "EUR-USD:PAIR:1.1000000000:VALID", "GBP-USD:DISPLAY:1.2500000000:VALID", "GBP-USD:PAIR:1.2500000000:VALID"]);
});

dbTest("with no included balances the run waits with a reason, announces nothing, and finishes when the balances arrive", async () => {
  const { t, c, w, event } = setup({ balances: [] });
  assert.equal(await ea.commands.onCycleInitiated(event()), "WAITING");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual([run.status, run.finishedAt], ["WAITING", null]);
  assert.match(run.waitReason!, /No included balances/);
  assert.deepEqual(await events(t), []);
  assert.deepEqual(await ea.questions.exposures(t, run.runId), []);
  assert.equal(await ea.commands.retryWaiting(t), 0);
  w.balances = [bal("US01", "4000", "EUR", "10")];
  assert.equal(await ea.commands.retryWaiting(t), 1);
  const after = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual([after.runId, after.status, after.waitReason], [run.runId, "FINISHED", null]);
  assert.equal((await events(t)).length, 2);
  assert.equal(await ea.commands.retryWaiting(t), 0, "a finished run is not tried again");
});

dbTest("a service that cannot be reached makes the run wait with that reason, and it finishes when the service is back", async () => {
  const { t, c, w, event } = setup();
  w.down = true;
  assert.equal(await ea.commands.onCycleInitiated(event()), "WAITING");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.match(run.waitReason!, /could not be reached: fx-rate unavailable/);
  assert.deepEqual(await events(t), []);
  w.down = false;
  assert.equal(await ea.commands.retryWaiting(t), 1);
  assert.equal((await ea.questions.currentRun(t, c))!.status, "FINISHED");
});

dbTest("a missing rate stops the run before it starts and names the pair; stale and outlier rates are used and flagged", async () => {
  const { t, c, w, event } = setup({ rates: new Map([["EUR|USD", { rate: "1.1", quality: "STALE" }]]) });
  assert.equal(await ea.commands.onCycleInitiated(event()), "WAITING");
  assert.match((await ea.questions.currentRun(t, c))!.waitReason!, /Missing spot rates on 2026-11-09 for GBP-USD/);
  assert.deepEqual(await events(t), []);
  w.rates.set("GBP|USD", { rate: "1.25", quality: "OUTLIER" });
  assert.equal(await ea.commands.retryWaiting(t), 1);
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual(run.warnings, [{ base: "EUR", quote: "USD", quality: "STALE" }, { base: "GBP", quote: "USD", quality: "OUTLIER" }]);
});

dbTest("the same event twice makes one run; a rerun supersedes the earlier run and gets its own run ID", async () => {
  const { t, c, event } = setup();
  const first = event();
  assert.equal(await ea.commands.onCycleInitiated(first), "FINISHED");
  assert.equal(await ea.commands.onCycleInitiated(first), "DUPLICATE");
  assert.equal((await events(t)).length, 2);
  const run1 = (await ea.questions.currentRun(t, c))!;
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run2 = (await ea.questions.currentRun(t, c))!;
  assert.notEqual(run2.runId, run1.runId);
  const statuses = await db.withSchema("exposure_analysis").selectFrom("runs").select(["run_id", "status"]).where("tenant_id", "=", t).execute();
  assert.deepEqual(statuses.map((s) => s.status).sort(), ["FINISHED", "SUPERSEDED"]);
  assert.equal((await events(t)).filter((e) => "runId" in e && e.runId === run2.runId).length, 2);
});

dbTest("a cycle that is closed, approved or past initiated is ignored", async () => {
  const a = setup(); Object.assign(a.w.cycles.get(a.c)!, { outcome: "SKIPPED" });
  assert.equal(await ea.commands.onCycleInitiated(a.event()), "IGNORED");
  const b = setup(); Object.assign(b.w.cycles.get(b.c)!, { stage: "IN_PROGRESS" });
  assert.equal(await ea.commands.onCycleInitiated(b.event()), "IGNORED");
  assert.equal(await ea.commands.onCycleInitiated({ eventId: randomUUID(), tenantId: a.t, cycleId: cycleId(randomUUID()) }), "IGNORED");
  assert.equal(await ea.questions.currentRun(a.t, a.c), null);
});

dbTest("approval freezes the current run: a later initiated event for the cycle changes nothing", async () => {
  const { t, c, w, event } = setup();
  await ea.commands.onCycleInitiated(event());
  const run = (await ea.questions.currentRun(t, c))!;
  await ea.commands.onCycleApproved({ tenantId: t, cycleId: c });
  const frozen = (await ea.questions.currentRun(t, c))!;
  assert.ok(frozen.frozenAt);
  w.balances = [bal("US01", "4000", "EUR", "99999")];
  assert.equal(await ea.commands.onCycleInitiated(event()), "IGNORED");
  const same = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual([same.runId, same.status], [run.runId, "FINISHED"]);
  assert.equal((await ea.questions.exposures(t, run.runId))[0]!.net1, "500.00");
});

dbTest("netting level comes from the cycle's settings: portfolio level re-pairs against the display currency", async () => {
  const { t, c, event } = setup({ balances: [bal("DE01", "4000", "GBP", "100"), bal("US01", "4000", "EUR", "50")] }, "GROUP_PORTFOLIO");
  w_rate(t, "EUR|GBP", "0.88");
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run = (await ea.questions.currentRun(t, c))!;
  const groups = await ea.questions.exposures(t, run.runId);
  assert.deepEqual(groups.map((g) => [g.currencyPair, g.nettingLevel, g.net1]), [["EUR-USD", "GROUP_PORTFOLIO", "-63.64"], ["GBP-USD", "GROUP_PORTFOLIO", "100.00"]]);
  // DE01's GBP balance (functional EUR) is an EUR-GBP row: -113.64 EUR / 100 GBP. In the portfolio its EUR leg nets with the EUR-USD row (+50) and its GBP leg is GBP-USD.
  const eur = await ea.questions.drilldown(t, run.runId, groups[0]!.groupNo);
  assert.deepEqual(eur.map((r) => [r.currencyPair, r.contribution.amount1]).sort(), [["EUR-GBP", "-113.64"], ["EUR-USD", "50.00"]]);
});
function w_rate(t: TenantId, key: string, rate: string) { world(t).rates.set(key, { rate, quality: "VALID" }); }

dbTest("one tenant never sees another's runs", async () => {
  const a = setup(); const b = setup();
  await ea.commands.onCycleInitiated(a.event());
  await ea.commands.onCycleInitiated(b.event());
  const run = (await ea.questions.currentRun(a.t, a.c))!;
  assert.equal(await ea.questions.currentRun(b.t, a.c), null);
  assert.deepEqual(await ea.questions.exposures(b.t, run.runId), []);
  assert.deepEqual(await ea.questions.ratesUsed(b.t, run.runId), []);
});

dbTest("exposure currency: an NDF currency in the pair decides it, a program override replaces it, and portfolio level ignores the override", async () => {
  const mk = (level: string, overrides: { pair: string; exposureCurrency: string }[]) => setup({
    balances: [bal("US01", "4000", "BRL", "500"), bal("US01", "4000", "EUR", "10")], ndf: ["BRL"],
    rates: new Map([["USD|BRL", { rate: "5", quality: "VALID" }], ["EUR|USD", { rate: "1.1", quality: "VALID" }], ["BRL|USD", { rate: "0.2", quality: "VALID" }]]),
  }, level, overrides);
  const exposure = async (s: ReturnType<typeof mk>) => {
    assert.equal(await ea.commands.onCycleInitiated(s.event()), "FINISHED");
    const run = (await ea.questions.currentRun(s.t, s.c))!;
    return (await ea.questions.exposures(s.t, run.runId)).map((g) => `${g.currencyPair}:${g.exposureCurrency}`);
  };
  assert.deepEqual(await exposure(mk("GROUP_NATURAL", [])), ["EUR-USD:EUR", "USD-BRL:BRL"]);
  assert.deepEqual(await exposure(mk("GROUP_NATURAL", [{ pair: "BRL-USD", exposureCurrency: "USD" }])), ["EUR-USD:EUR", "USD-BRL:USD"]);
  assert.deepEqual(await exposure(mk("GROUP_PORTFOLIO", [{ pair: "EUR-USD", exposureCurrency: "USD" }])), ["EUR-USD:EUR", "USD-BRL:BRL"]);
});

const hedge = (entityCode: string, direction: "BUY" | "SELL", deal: string, dealAmount: string, settle: string, settleAmount: string, valueDate: string, id = "x1"): ExecutedTrade => ({
  executedTradeId: id, platform: "P", tradeId: id, version: 1, cancelled: false, programId: programId("BS"), tradingEntityCode: entityCode, counterparty: null, tradeDate: asOfDate("2026-11-01"),
  instrument: "FORWARD", portfolio: null, customFields: {}, matchStatus: "MATCHED", preTradeId: null, matchNote: null, candidates: [], batchId: null,
  legs: [{ legNo: 1, role: "SINGLE", direction, dealCurrency: deal, dealAmount, settlementCurrency: settle, settlementAmount: settleAmount, valueDate, fixingDate: null }],
} as ExecutedTrade);

dbTest("net exposure is gross plus outstanding hedges; a matured leg and an unknown entity are left out, and a hedge-only group still appears (decision 0010)", async () => {
  const { t, c, event } = setup({
    balances: [bal("US01", "4000", "EUR", "1000"), bal("DE01", "4000", "USD", "550")],
    trades: [
      hedge("US01", "SELL", "EUR", "400", "USD", "440", "2027-01-15", "h1"),
      hedge("US01", "SELL", "EUR", "50", "USD", "55", "2026-11-09", "matured"),
      hedge("NOPE", "BUY", "EUR", "10", "USD", "11", "2027-01-15", "ghost"),
      hedge("US01", "SELL", "GBP", "100", "USD", "125", "2027-01-15", "h2"),
    ],
  });
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual(run.hedgeCounts, { trades: 4, openLegs: 3, used: 2, noEntity: 1, excluded: [{ executedTradeId: "ghost", platform: "P", tradeId: "ghost", legNo: 1, entityCode: "NOPE", reason: "TRADING_ENTITY_NOT_ON_RECORD" }] });
  const gross = await ea.questions.exposures(t, run.runId);
  assert.deepEqual(gross.map((g) => g.currencyPair), ["EUR-USD"], "gross is unchanged by hedges");
  const net = await ea.questions.netExposures(t, run.runId);
  assert.deepEqual(net.map((n) => [n.currencyPair, n.gross.exposureAmount, n.hedges.exposureAmount, n.net.exposureAmount, n.exposureCurrency]), [
    ["EUR-USD", "500.00", "-400.00", "100.00", "EUR"], ["GBP-USD", "0.00", "-100.00", "-100.00", "GBP"]]);
  const eur = net[0]!;
  assert.deepEqual([eur.hedges.net1, eur.hedges.net2, eur.net.net1, eur.net.net2, eur.net.displayAmount, eur.hedges.displayAmount], ["-400.00", "440.00", "100.00", "-110.00", "110.00", "-440.00"]);
  const rows = await ea.questions.hedgeRows(t, run.runId);
  assert.deepEqual(rows.map((r) => [r.tradeId, r.entityCode, r.region, r.currencyPair, r.amount1, r.amount2]), [["h1", "US01", "AMER", "EUR-USD", "-400.00", "440.00"], ["h2", "US01", "AMER", "GBP-USD", "-100.00", "125.00"]]);
});

dbTest("a program with no executed trades has net equal to gross", async () => {
  const { t, c, event } = setup();
  await ea.commands.onCycleInitiated(event());
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual(run.hedgeCounts, { trades: 0, openLegs: 0, used: 0, noEntity: 0, excluded: [] });
  const net = await ea.questions.netExposures(t, run.runId);
  assert.ok(net.length > 0 && net.every((n) => n.net.exposureAmount === n.gross.exposureAmount && n.hedges.exposureAmount === "0.00"));
});

dbTest("entity level: hedges without the entity's functional currency in the pair are keyed by their deal currency, so EUR-deal and GBP-deal trades give two rows; cents are kept (decision 0010)", async () => {
  const { t, c, event } = setup({
    balances: [bal("US01", "4000", "EUR", "1000")],
    trades: [
      hedge("US01", "BUY", "EUR", "100.45", "GBP", "87.30", "2027-01-15", "d1"),
      hedge("US01", "BUY", "EUR", "10.10", "GBP", "8.80", "2027-01-15", "d2"),
      hedge("US01", "SELL", "GBP", "50.10", "EUR", "57.80", "2027-01-15", "d3"),
    ],
  }, "ENTITY");
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.equal(run.status, "FINISHED");
  const net = (await ea.questions.netExposures(t, run.runId)).filter((n) => n.currencyPair.includes("GBP") && n.currencyPair.includes("EUR"));
  assert.equal(net.length, 2, "one row per exposure currency");
  const byCcy = new Map(net.map((n) => [n.exposureCurrency, n]));
  assert.deepEqual([...byCcy.keys()].sort(), ["EUR", "GBP"]);
  // same full key nets together: d1 and d2 are EUR-deal; d3 is GBP-deal
  assert.equal(byCcy.get("EUR")!.hedges.exposureAmount, "110.55");
  assert.equal(byCcy.get("GBP")!.hedges.exposureAmount, "-50.10");
  assert.ok(net.every((n) => n.gross.exposureAmount === "0.00" && n.net.exposureAmount === n.hedges.exposureAmount), "gross, hedge and net are aligned on the full key");
});

dbTest("a hedge whose trading entity is missing is excluded and recorded by trade and leg, and the run still finishes without waiting", async () => {
  const { t, c, event } = setup({ balances: [bal("US01", "4000", "EUR", "1000")], trades: [hedge("LATER", "SELL", "EUR", "5.55", "USD", "6.10", "2027-01-15", "m1")] });
  assert.equal(await ea.commands.onCycleInitiated(event()), "FINISHED");
  const run = (await ea.questions.currentRun(t, c))!;
  assert.deepEqual([run.hedgeCounts!.used, run.hedgeCounts!.noEntity, run.hedgeCounts!.excluded.map((x) => x.tradeId)], [0, 1, ["m1"]]);
  assert.equal(run.waitReason, null);
});

dbTest("region by entity: the deal-currency rule applies too, and a program override for the pair replaces it; no default ranking (decision 0010)", async () => {
  const trades = [hedge("US01", "BUY", "EUR", "100", "GBP", "87", "2027-01-15", "r1"), hedge("US01", "SELL", "GBP", "50", "EUR", "57", "2027-01-15", "r2")];
  const a = setup({ balances: [bal("US01", "4000", "EUR", "1000")], trades }, "REGION_BY_ENTITY");
  assert.equal(await ea.commands.onCycleInitiated(a.event()), "FINISHED");
  const runA = (await ea.questions.currentRun(a.t, a.c))!;
  const pairA = (await ea.questions.netExposures(a.t, runA.runId)).filter((n) => n.currencyPair.includes("GBP") && n.currencyPair.includes("EUR"));
  assert.deepEqual(pairA.map((n) => n.exposureCurrency).sort(), ["EUR", "GBP"]);
  const pair = pairA[0]!.currencyPair;
  const b = setup({ balances: [bal("US01", "4000", "EUR", "1000")], trades }, "REGION_BY_ENTITY", [{ pair, exposureCurrency: "GBP" }]);
  assert.equal(await ea.commands.onCycleInitiated(b.event()), "FINISHED");
  const runB = (await ea.questions.currentRun(b.t, b.c))!;
  const pairB = (await ea.questions.netExposures(b.t, runB.runId)).filter((n) => n.currencyPair === pair);
  assert.deepEqual(pairB.map((n) => n.exposureCurrency), ["GBP"], "the override puts both trades in one row");
});
