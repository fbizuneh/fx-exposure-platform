// Release 1 UAT rehearsal: real loaders and services, with independent dated results.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { Decimal } from "decimal.js";
import { asOfDate, type TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import type { NetExposureGroup } from "@services/exposure-analysis/contract";
import { migrate } from "../migrate.mjs";
import { composeApp, type App } from "../../app/src/compose.ts";
import { drain } from "../../app/src/dispatch.ts";
import { loadAccountsFile, loadCalendarsFile, loadCurrenciesFile, loadEntitiesFile, loadExecutedFile, loadExposureCurrenciesFile, loadGlFile, loadHierarchyFile, loadRatesFile, type LoadOutcome } from "../../app/src/loaders/index.ts";
import { configureWithActors, type UatConfig } from "./configure.ts";
import { generate } from "./generate.ts";
import { simulate } from "./simulate.ts";
import { uatDatabaseName } from "./reset.ts";

const CONFIG = "packs/uat/config.json";
const PACK = "packs/uat/generated";
const EXPECTED = "packs/uat/expected";
type ExpectedRow = Record<string, string>;

function rows(text: string): ExpectedRow[] {
  const [header, ...body] = text.trimEnd().split(/\r?\n/);
  if (!header) throw new Error("expected CSV has no header");
  const names = header.split(",");
  return body.map((line) => Object.fromEntries(line.split(",").map((value, i) => [names[i]!, value])));
}

function key(program: string, level: string, region: string | null, entity: string | null, pair: string, exposure: string, period: string): string {
  return [program, level, region ?? "", entity ?? "", pair, exposure, period].join("|");
}

/** Compare every group and numeric column; report the first concrete difference. */
export function compareExposure(program: string, expected: readonly ExpectedRow[], actual: readonly NetExposureGroup[]): void {
  const before = new Map(expected.filter((r) => r.program_id === program).map((r) => [key(r.program_id!, r.netting_level!, r.region!, r.entity_code!, r.pair!, r.exposure_currency!, r.period!), r]));
  const after = new Map(actual.map((r) => [key(program, r.nettingLevel, r.region, r.entityCode, r.currencyPair, r.exposureCurrency, r.period), r]));
  const fields = [
    ["gross_currency1", (r: NetExposureGroup) => r.gross.net1], ["gross_currency2", (r: NetExposureGroup) => r.gross.net2], ["gross_exposure", (r: NetExposureGroup) => r.gross.exposureAmount], ["gross_display", (r: NetExposureGroup) => r.gross.displayAmount],
    ["hedge_currency1", (r: NetExposureGroup) => r.hedges.net1], ["hedge_currency2", (r: NetExposureGroup) => r.hedges.net2], ["hedge_exposure", (r: NetExposureGroup) => r.hedges.exposureAmount], ["hedge_display", (r: NetExposureGroup) => r.hedges.displayAmount],
    ["net_currency1", (r: NetExposureGroup) => r.net.net1], ["net_currency2", (r: NetExposureGroup) => r.net.net2], ["net_exposure", (r: NetExposureGroup) => r.net.exposureAmount], ["net_display", (r: NetExposureGroup) => r.net.displayAmount],
  ] as const;
  const differences: string[] = [];
  for (const [id, want] of before) {
    const got = after.get(id);
    if (!got) { differences.push(`${id}: missing platform group`); continue; }
    for (const [field, read] of fields) if (want[field] !== read(got)) differences.push(`${id} ${field}: expected ${want[field]}, got ${read(got)}`);
  }
  for (const id of after.keys()) if (!before.has(id)) differences.push(`${id}: unexpected platform group`);
  if (differences.length) throw new Error(`exposure mismatch (${differences.length} differences):\n${differences.slice(0, 20).join("\n")}`);
}

function applied(outcome: LoadOutcome, file: string): void {
  if (outcome.kind !== "DONE" || outcome.status !== "APPLIED") throw new Error(`${file}: ${JSON.stringify(outcome)}`);
}

async function emptyDatabase(url: string): Promise<void> {
  if (!uatDatabaseName(url).endsWith("_uat")) throw new Error("E7 requires an empty database ending _uat");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ schema_name: string }>("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1)", [["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"]]);
    if (result.rows.length) throw new Error(`E7 requires an empty _uat database; existing service schemas: ${result.rows.map((r) => r.schema_name).join(", ")}`);
  } finally { await client.end(); }
}

async function stage(name: string, work: () => Promise<void>): Promise<void> {
  const start = performance.now();
  await work();
  console.log(`${name}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
}

async function loadPack(app: App, config: UatConfig, tenants: readonly TenantId[]): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(PACK, "manifest.json"), "utf8")) as { files: { file: string }[] };
  const glDays = manifest.files.filter((f) => /^gl\/gl-\d{4}-\d{2}-\d{2}\.csv$/.test(f.file)).map((f) => f.file.slice(6, 16)).sort();
  const rateFiles = manifest.files.filter((f) => /^rates\/rates-\d{4}-\d{2}-\d{2}\.csv$/.test(f.file)).map((f) => f.file).sort();
  if (glDays.length !== 20 || rateFiles.length !== 262) throw new Error("generated pack has the wrong GL or rate date count");
  const master = { entities: loadEntitiesFile, hierarchy: loadHierarchyFile, accounts: loadAccountsFile, currencies: loadCurrenciesFile, calendars: loadCalendarsFile } as const;
  for (const [i, tenantId] of tenants.entries()) {
    for (const [name, load] of Object.entries(master)) {
      const file = `${name}.csv`;
      applied(await load(app, { tenantId, text: await readFile(join(PACK, file), "utf8"), sourceSystem: "uat-master", asOf: asOfDate("2025-11-20"), mode: "SNAPSHOT", by: "uat-rehearsal" }), file);
      await drain(app);
    }
    applied(await loadExposureCurrenciesFile(app, { tenantId, text: await readFile(join(PACK, "exposure-currencies.csv"), "utf8"), sourceSystem: "uat-master", asOf: asOfDate("2025-11-20"), mode: "SNAPSHOT", programCode: config.tenants[i]!.program.id, by: "uat-rehearsal" }), "exposure-currencies.csv");
    await drain(app);
    for (const file of rateFiles) {
      applied(await loadRatesFile(app, { tenantId, text: await readFile(join(PACK, file), "utf8"), source: "uat-rates", businessDate: asOfDate(file.slice(12, 22)), by: "uat-rehearsal" }), file);
      await drain(app);
    }
    const history = `executed-history-${config.tenants[i]!.program.id}.csv`;
    applied(await loadExecutedFile(app, { tenantId, text: await readFile(join(PACK, history), "utf8"), by: "uat-rehearsal" }), history);
    await drain(app);
    for (const day of glDays) {
      const file = `gl/gl-${day}.csv`;
      applied(await loadGlFile(app, { tenantId, text: await readFile(join(PACK, file), "utf8"), chartCode: "UAT", asOf: asOfDate(day), sourceSystem: "uat-gl", by: "uat-rehearsal" }), file);
      await drain(app);
    }
  }
  return glDays;
}

async function compareDatedRuns(app: App, config: UatConfig, tenants: readonly TenantId[], actors: readonly ReadonlyMap<string, Actor>[], days: readonly string[]): Promise<void> {
  const status = JSON.parse(await readFile(join(EXPECTED, "expected-status.json"), "utf8")) as { date: string; status: string }[];
  for (const day of days) {
    const expected = rows(await readFile(join(EXPECTED, `${day}.csv`), "utf8"));
    for (const [i, tenantId] of tenants.entries()) {
      const program = config.tenants[i]!.program.id;
      const actor = actors[i]!.get(config.adminUser)!;
      const cycleId = await app.exposureManagement.commands.startCycle({ tenantId, programId: program, asOf: day, actor });
      await drain(app);
      const run = await app.exposureAnalysis.questions.currentRun(tenantId, cycleId);
      if (!run) throw new Error(`${program} ${day}: no run`);
      const expectedStatus = status.find((entry) => entry.date === day)?.status;
      if (expectedStatus?.startsWith("NO_RATE ")) {
        if (run.status !== "WAITING" || !run.waitReason?.startsWith(`Missing spot rates on ${day} for `)) throw new Error(`${program} ${day}: expected missing-rate wait, got ${run.status}: ${run.waitReason}`);
      } else {
        if (run.status !== "FINISHED") throw new Error(`${program} ${day}: expected FINISHED, got ${run.status}: ${run.waitReason}`);
        compareExposure(program, expected, await app.exposureAnalysis.questions.netExposures(tenantId, run.runId));
      }
      await app.exposureManagement.commands.skipCycle({ tenantId, cycleId, reason: "E7 dated comparison complete", actor });
      await drain(app);
    }
  }
}

async function tradeAndNextCycle(app: App, config: UatConfig, tenantId: TenantId, actors: ReadonlyMap<string, Actor>): Promise<void> {
  const starter = actors.get("Tavi Reed")!;
  const decider = actors.get(config.adminUser)!;
  const cycleApprover = actors.get("Ivo Lark")!;
  const programId = "BS-ENT";
  const first = await app.exposureManagement.commands.startCycle({ tenantId, programId, asOf: "2026-11-19", actor: starter });
  await drain(app);
  await app.hedgeRecommendation.commands.setRollDates({ tenantId, cycleId: first, actor: decider, dates: { nearDate: "2026-11-27", farDate: "2027-02-23", offsetDays: 0 } });
  await app.exposureManagement.commands.rerunCycle({ tenantId, cycleId: first, actor: starter });
  await drain(app);
  const approvedRun = await app.exposureAnalysis.questions.currentRun(tenantId, first);
  if (approvedRun?.status !== "FINISHED") throw new Error(`scenario 8: expected finished run, got ${approvedRun?.status ?? "none"}`);
  await app.exposureManagement.commands.approveExposure({ tenantId, cycleId: first, actor: decider });
  await drain(app);
  const recs = await app.hedgeRecommendation.questions.recommendations(tenantId, first);
  const chosen = recs.find((r) => r.currencyPair === "EUR-USD" && r.action === "HEDGE" && r.parts.some((p) => p.role === "CLOSE_OUT" && p.valueDate === "2026-11-27") && r.parts.some((p) => (p.role === "ROLL" || p.role === "COMBINED") && p.valueDate === "2027-02-23"));
  if (!chosen) throw new Error("scenario 8: no EUR/USD close-out and far roll recommendation");
  await app.hedgeRecommendation.commands.decide({ tenantId, recommendationId: chosen.recommendationId, actor: decider, action: "ACCEPT" });
  await app.exposureManagement.commands.approveCycle({ tenantId, cycleId: first, actor: cycleApprover });
  await drain(app);
  await finishReleasedTrade(app, config, tenantId, decider, starter);
}

/** Continues after cycle approval; also useful to verify a failed rehearsal without repeating the bulk load. */
export async function finishReleasedTrade(app: App, config: UatConfig, tenantId: TenantId, exporter: Actor, starter: Actor): Promise<void> {
  const exported = await app.fxTrade.commands.exportPreTrades({ tenantId, actor: exporter });
  if (exported.preTradeIds.length < 2) throw new Error(`scenario 8: expected at least two released forwards, got ${exported.preTradeIds.length}`);
  const executed = simulate({ pretrades: exported.file, rates: await readFile(join(PACK, "rates/rates-2026-11-20.csv"), "utf8"), tradeDate: "2026-11-20", seed: "20261120", portfolioByProgram: config.simulator.portfolioByProgram });
  const imported = await loadExecutedFile(app, { tenantId, text: executed, by: "uat-rehearsal" });
  if (imported.kind !== "DONE" || imported.counts.matched !== exported.preTradeIds.length || imported.counts.blocked !== 0) throw new Error(`scenario 8: executed import did not match every released pre-trade: ${JSON.stringify(imported)}`);
  await drain(app);
  const next = await app.exposureManagement.commands.startCycle({ tenantId, programId: "BS-ENT", asOf: "2026-11-20", actor: starter });
  await drain(app);
  const nextRun = await app.exposureAnalysis.questions.currentRun(tenantId, next);
  if (nextRun?.status !== "FINISHED") throw new Error(`scenario 9: expected finished next run, got ${nextRun?.status ?? "none"}`);
  const importedIds = new Set(executed.trimEnd().split(/\r?\n/).slice(1).map((line) => line.split(",")[0]!));
  const used = (await app.exposureAnalysis.questions.hedgeRows(tenantId, nextRun.runId)).filter((row) => importedIds.has(row.tradeId));
  if (used.length < 2 || !used.some((row) => row.valueDate === "2026-11-27") || !used.some((row) => row.valueDate === "2027-02-23")) throw new Error(`scenario 9: next run used ${used.length} new hedge legs; expected November 27 and February 23`);
  await app.exposureManagement.commands.skipCycle({ tenantId, cycleId: next, reason: "E7 next-cycle hedge check complete", actor: starter });
  await drain(app);
  console.log(`scenario 8–9: ${exported.preTradeIds.length} matched executions, ${used.length} new hedge legs in next run`);
}

type Totals = Record<string, { rows: number; balance: string }>;
type DirtyExpected = { batchControlTotals: Totals; byProgram: Record<string, { included: Totals; excluded: Totals; blocked: Totals; byReason: Record<string, Totals> }> };
function total(totals: Totals, currency: string): { rows: number; sum: string } {
  const bucket = totals[currency];
  return { rows: bucket?.rows ?? 0, sum: new Decimal(bucket?.balance ?? 0).toFixed(4) };
}
function count(totals: Totals): number { return Object.values(totals).reduce((sum, bucket) => sum + bucket.rows, 0); }

export async function checkDirtyFixtures(app: App, config: UatConfig, tenants: readonly TenantId[]): Promise<void> {
  const expected = JSON.parse(await readFile(join(EXPECTED, "gl-dirty-expected.json"), "utf8")) as DirtyExpected;
  const malformedExpected = JSON.parse(await readFile(join(EXPECTED, "gl-malformed-problems.json"), "utf8")) as { problems: { row: number; column: string }[] };
  const dirtyText = await readFile(join(PACK, "gl-dirty.csv"), "utf8");
  const malformedText = await readFile(join(PACK, "gl-malformed.csv"), "utf8");
  const control = Object.entries(expected.batchControlTotals).map(([currency, bucket]) => ({ currency, rowCount: bucket.rows, sum: bucket.balance }));
  for (const [i, tenantId] of tenants.entries()) {
    const common = { tenantId, chartCode: "UAT", asOf: asOfDate("2026-11-20"), sourceSystem: "uat-gl", by: "uat-rehearsal" };
    const malformed = await loadGlFile(app, { ...common, text: malformedText });
    if (malformed.kind !== "INVALID_FILE" || JSON.stringify(malformed.problems.map((p) => [p.rowNo, p.column])) !== JSON.stringify(malformedExpected.problems.map((p) => [p.row, p.column]))) throw new Error(`malformed GL fixture: ${JSON.stringify(malformed)}`);
    const dirty = await loadGlFile(app, { ...common, text: dirtyText, expectedTotals: control });
    applied(dirty, "gl-dirty.csv");
    await drain(app);
    const program = config.tenants[i]!.program.id;
    const prediction = expected.byProgram[program]!;
    if (dirty.kind !== "DONE" || dirty.counts.received !== 20000 || dirty.counts.included !== count(prediction.included) || dirty.counts.excluded !== count(prediction.excluded) || dirty.counts.blocked !== count(prediction.blocked)) throw new Error(`${program}: dirty GL counts differ from oracle: ${JSON.stringify(dirty)}`);
    const batches = await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "uat-gl", asOf: common.asOf });
    const batch = batches.find((b) => b.current);
    if (!batch) throw new Error(`${program}: dirty GL has no current batch`);
    const actual = await app.dataSource.questions.controlTotals(tenantId, batch.batchId);
    const currencies = new Set([...Object.keys(expected.batchControlTotals), ...Object.keys(prediction.included), ...Object.keys(prediction.excluded), ...Object.keys(prediction.blocked)]);
    for (const currency of currencies) {
      const got = actual.find((row) => row.currency === currency);
      if (!got) throw new Error(`${program} ${currency}: no control total`);
      for (const [name, want, rows, sum] of [
        ["received", expected.batchControlTotals, got.receivedRows, got.receivedSum],
        ["included", prediction.included, got.includedRows, got.includedSum],
        ["excluded", prediction.excluded, got.excludedRows, got.excludedSum],
        ["blocked", prediction.blocked, got.blockedRows, got.blockedSum],
      ] as const) {
        const forecast = total(want, currency);
        if (rows !== forecast.rows || sum !== forecast.sum) throw new Error(`${program} ${currency} ${name}: expected ${forecast.rows}/${forecast.sum}, got ${rows}/${sum}`);
      }
    }
    const issues = await app.dataSource.questions.dataQualityIssues(tenantId, { batchId: batch.batchId });
    for (const code of ["GL_ENTITY_UNKNOWN", "GL_ACCOUNT_UNKNOWN"]) {
      const found = issues.filter((issue) => issue.ruleCode === code).length;
      if (found !== count(prediction.byReason[code]!)) throw new Error(`${program} ${code}: expected ${count(prediction.byReason[code]!)}, got ${found}`);
    }
    applied(await loadGlFile(app, { ...common, text: await readFile(join(PACK, "gl/gl-2026-11-20.csv"), "utf8") }), "restored clean GL");
    await drain(app);
  }
}

export async function rehearse(url: string): Promise<void> {
  await emptyDatabase(url);
  const config = JSON.parse(await readFile(CONFIG, "utf8")) as UatConfig;
  const committedManifest = await readFile(join(PACK, "manifest.json"), "utf8");
  await stage("generate pack", async () => {
    await generate(20261120, PACK);
    if (await readFile(join(PACK, "manifest.json"), "utf8") !== committedManifest) throw new Error("generated manifest differs from committed seed 20261120 manifest");
  });
  await stage("migrate", async () => { await migrate(url); });
  const app = composeApp(url);
  try {
    let tenants: readonly TenantId[] = [], actors: readonly ReadonlyMap<string, Actor>[] = [];
    await stage("configure", async () => { ({ tenantIds: tenants, actors } = await configureWithActors(app, config)); });
    let days: string[] = [];
    await stage("load master data, rates, history and GL", async () => { days = await loadPack(app, config, tenants); });
    await stage("compare 20 dated runs for both programs", async () => { await compareDatedRuns(app, config, tenants, actors, days); });
    await stage("approve, simulate, import and check next cycle", async () => { await tradeAndNextCycle(app, config, tenants[0]!, actors[0]!); });
    await stage("check malformed and dirty GL fixtures", async () => { await checkDirtyFixtures(app, config, tenants); });
  } finally { await app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exitCode = 1; }
  else rehearse(url).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
