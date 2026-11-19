// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// exposure_analysis schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, accountId, cycleId, entityId, lineageRef, programId, tenantId, type CycleId, type TenantId } from "@shared/kernel";
import type { IncludedBalance, IngestionStatus } from "@services/data-source/contract";
import type { Cycle } from "@services/exposure-management/contract";
import type { Rate } from "@services/fx-rate/contract";
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
  rates: {
    async getRate(query: { tenantId: TenantId; base: string; quote: string }): Promise<Rate | null> {
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
