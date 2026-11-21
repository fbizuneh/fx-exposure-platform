// D6: full loader path through composeApp. Needs TEST_DATABASE_URL (*_test).
// Per loader: valid → stores; same file → DUPLICATE; one bad row → INVALID_FILE, nothing stored;
// service refusal → REFUSED, nothing stored. CLI child-process exit codes (incl. one success per kind).
// 20k GL under 60s with separate parse vs service timings. E3 pack generated once into a temp dir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { asOfDate, programId, type TenantId } from "@shared/kernel";
import { parseGlFile } from "../../../services/data-source/src/index.ts";
import { generate } from "../../../scripts/uat/generate.ts";
import { migrate } from "../../../scripts/migrate.mjs";
import { composeApp, type App } from "../compose.ts";
import {
  loadAccountsFile,
  loadCalendarsFile,
  loadCurrenciesFile,
  loadEntitiesFile,
  loadExecutedFile,
  loadExposureCurrenciesFile,
  loadGlFile,
  loadHierarchyFile,
  loadRatesFile,
} from "./index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("loader database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>, opts: { timeout?: number } = {}) =>
  test(name, { skip: !enabled, ...opts }, fn);

const clock = { now: new Date("2026-03-10T12:00:00Z") };
let app: App;
let e3PackDir: string | null = null;

before(async () => {
  if (!enabled) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of [
    "audit",
    "identity",
    "master_data",
    "fx_rate",
    "data_source",
    "exposure_management",
    "exposure_analysis",
    "fx_trade",
    "hedge_recommendation",
  ]) {
    await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  }
  await client.end();
  await migrate(url!);
  app = composeApp(url!, () => clock.now);
});
after(async () => {
  if (enabled) await app.close();
  if (e3PackDir) await rm(e3PackDir, { recursive: true, force: true });
});

/** Seeded E3 pack (seed 20261120) once per process; large CSVs stay out of git. */
async function ensureE3Pack(): Promise<string> {
  if (e3PackDir) return e3PackDir;
  e3PackDir = await mkdtemp(join(tmpdir(), "d6-e3-pack-"));
  await generate(20261120, e3PackDir);
  return e3PackDir;
}

const D1 = asOfDate("2026-03-09");
const D2 = asOfDate("2026-03-10");
const by = "loader-db-test";

async function newTenant(): Promise<TenantId> {
  return app.identity.commands.createTenant(`loaders-${randomUUID().slice(0, 8)}`);
}

const currenciesCsv = (rows: string[]) => ["code,is_ndf", ...rows].join("\n");
const entitiesCsv = (rows: string[]) =>
  [
    "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity",
    ...rows,
  ].join("\n");
const hierarchyCsv = (rows: string[]) => ["chart_code,code,name,classification,parent_code", ...rows].join("\n");
const accountsCsv = (rows: string[]) =>
  [
    "chart_code,account_number,name,statement_type,normal_balance,monetary_flag,fx_relevant_flag,hierarchy_node_code",
    ...rows,
  ].join("\n");
const calendarsCsv = (rows: string[]) =>
  ["currency_code,weekend_days,covered_through,holiday_date,holiday_name", ...rows].join("\n");
const exposureCsv = (rows: string[]) => ["pair,exposure_currency", ...rows].join("\n");
const glCsv = (rows: string[]) =>
  ["entity_code,account_number,currency,balance,debit,credit,as_of", ...rows].join("\n");
const ratesCsv = (rows: string[]) =>
  [
    "base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at",
    ...rows,
  ].join("\n");
const executedHeader =
  "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,portfolio,hedging_program_id,pre_trade_reference,leg";
const executedCsv = (rows: string[]) => [executedHeader, ...rows].join("\n");

async function seedGlMaster(tenantId: TenantId): Promise<void> {
  await loadCurrenciesFile(app, {
    tenantId,
    text: currenciesCsv(["USD,false", "EUR,false"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv([
      "G,Group,GROUP,,,,false,false,false",
      "US1,Acme US,LEGAL_ENTITY,G,US,USD,true,true,true",
    ]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  await loadHierarchyFile(app, {
    tenantId,
    text: hierarchyCsv(["MAIN,CASH,Cash,ASSETS,"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  await loadAccountsFile(app, {
    tenantId,
    text: accountsCsv(["MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,CASH"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
}

const E3_MD_ASOF = asOfDate("2025-11-20");
const E3_GL_ASOF = asOfDate("2026-11-20");
const E3_CHART = "UAT";

/** Load E3 master-data files so dirty/malformed GL rows resolve against the seeded pack. */
async function seedFromE3Pack(tenantId: TenantId, packDir: string): Promise<void> {
  clock.now = new Date("2026-11-21T12:00:00Z");
  const md = async (
    kind: "currencies" | "entities" | "hierarchy" | "accounts" | "calendars",
    file: string,
  ) => {
    const text = await readFile(join(packDir, file), "utf8");
    const opts = { tenantId, text, sourceSystem: "uat", asOf: E3_MD_ASOF, mode: "SNAPSHOT" as const, by };
    if (kind === "currencies") return loadCurrenciesFile(app, opts);
    if (kind === "entities") return loadEntitiesFile(app, opts);
    if (kind === "hierarchy") return loadHierarchyFile(app, opts);
    if (kind === "accounts") return loadAccountsFile(app, opts);
    return loadCalendarsFile(app, opts);
  };
  for (const [kind, file] of [
    ["currencies", "currencies.csv"],
    ["entities", "entities.csv"],
    ["hierarchy", "hierarchy.csv"],
    ["accounts", "accounts.csv"],
    ["calendars", "calendars.csv"],
  ] as const) {
    const out = await md(kind, file);
    assert.equal(out.kind, "DONE", `${file}: ${JSON.stringify(out)}`);
    if (out.kind === "DONE") assert.equal(out.status, "APPLIED");
  }
}

function buildGlValid20k(): string {
  const lines = ["entity_code,account_number,currency,balance,debit,credit,as_of"];
  for (let i = 0; i < 20_000; i++) {
    // Distinct keys: entity + account + currency (no dims).
    const entity = `E${String((i % 50) + 1).padStart(2, "0")}`;
    const account = String(1000 + Math.floor(i / 50));
    lines.push(`${entity},${account},USD,${(i % 1000) + 0.5},,,2026-03-09`);
  }
  return `${lines.join("\n")}\n`;
}

// --- currencies ---

dbTest("currencies: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = currenciesCsv(["USD,false", "EUR,false"]);
  const opts = { tenantId, text, sourceSystem: "md", asOf: D1, mode: "SNAPSHOT" as const, by };
  const first = await loadCurrenciesFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind !== "DONE") return;
  assert.equal(first.status, "APPLIED");
  assert.deepEqual(first.counts, { created: 2, changed: 0, ended: 0, unchanged: 0 });
  assert.deepEqual(await app.masterData.questions.getCurrencies(tenantId, D1), [
    { code: "EUR", isNdf: false },
    { code: "USD", isNdf: false },
  ]);
  const second = await loadCurrenciesFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("currencies: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = currenciesCsv(["USD,false", "US,false"]);
  const out = await loadCurrenciesFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 2 && p.column === "code"));
  }
  assert.deepEqual(await app.masterData.questions.getCurrencies(tenantId, D1), []);
});

dbTest("currencies: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  await loadCurrenciesFile(app, {
    tenantId,
    text: currenciesCsv(["USD,false"]),
    sourceSystem: "md",
    asOf: D2,
    mode: "SNAPSHOT",
    by,
  });
  const refused = await loadCurrenciesFile(app, {
    tenantId,
    text: currenciesCsv(["EUR,false"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(refused.kind, "REFUSED");
  if (refused.kind === "REFUSED") assert.match(refused.message, /rewrite history/);
  assert.equal((await app.masterData.questions.getCurrencies(tenantId, D1)).length, 0);
  assert.equal((await app.masterData.questions.getCurrencies(tenantId, D2))[0]?.code, "USD");
});

// --- entities ---

dbTest("entities: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = entitiesCsv(["G,Group,GROUP,,,,false,false,false", "BU1,Unit,BUSINESS_UNIT,G,,,false,false,false"]);
  const opts = { tenantId, text, sourceSystem: "erp", asOf: D1, mode: "SNAPSHOT" as const, by };
  const first = await loadEntitiesFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") assert.equal(first.status, "APPLIED");
  assert.equal((await app.masterData.questions.getEntity(tenantId, "BU1", D1))?.code, "BU1");
  const second = await loadEntitiesFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("entities: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = entitiesCsv(["G,Group,GROUP,,,,false,false,maybe"]);
  const out = await loadEntitiesFile(app, {
    tenantId,
    text,
    sourceSystem: "erp",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "is_hedge_execution_entity"));
  }
  assert.equal(await app.masterData.questions.getEntity(tenantId, "G", D1), null);
});

dbTest("entities: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  const text = entitiesCsv(["US1,Acme US,LEGAL_ENTITY,,US,,true,false,false"]);
  const out = await loadEntitiesFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "REFUSED");
  if (out.kind === "REFUSED") assert.match(out.message, /functional currency|change set is invalid/i);
  assert.equal(await app.masterData.questions.getEntity(tenantId, "US1", D1), null);
});

// --- hierarchy ---

dbTest("hierarchy: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = hierarchyCsv(["MAIN,BS,Balance sheet,BALANCE_SHEET,", "MAIN,ASSETS,Assets,ASSETS,BS"]);
  const opts = { tenantId, text, sourceSystem: "md", asOf: D1, mode: "SNAPSHOT" as const, by };
  const first = await loadHierarchyFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") {
    assert.equal(first.status, "APPLIED");
    assert.equal(first.counts.created, 2);
  }
  const paths = await app.masterData.questions.hierarchyPaths(tenantId, "MAIN", ["ASSETS"], D1);
  assert.deepEqual(paths[0]?.path, ["ASSETS", "BS"]);
  const second = await loadHierarchyFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("hierarchy: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = hierarchyCsv(["MAIN,BS,Balance sheet,NOT_A_CLASS,"]);
  const out = await loadHierarchyFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "classification"));
  }
  assert.deepEqual(await app.masterData.questions.hierarchyPaths(tenantId, "MAIN", ["BS"], D1), []);
});

dbTest("hierarchy: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  const text = hierarchyCsv(["MAIN,A,Node A,ASSETS,B", "MAIN,B,Node B,ASSETS,A"]);
  const out = await loadHierarchyFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "REFUSED");
  if (out.kind === "REFUSED") assert.match(out.message, /cycle|change set is invalid/i);
  assert.deepEqual(await app.masterData.questions.hierarchyPaths(tenantId, "MAIN", ["A", "B"], D1), []);
});

// --- accounts ---

dbTest("accounts: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  await loadHierarchyFile(app, {
    tenantId,
    text: hierarchyCsv(["MAIN,CASH,Cash,ASSETS,"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  const text = accountsCsv(["MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,CASH"]);
  const opts = { tenantId, text, sourceSystem: "md", asOf: D1, mode: "SNAPSHOT" as const, by };
  const first = await loadAccountsFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") assert.equal(first.status, "APPLIED");
  assert.equal((await app.masterData.questions.getAccount(tenantId, "MAIN", "1000", D1))?.name, "Cash");
  const second = await loadAccountsFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("accounts: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = accountsCsv(["MAIN,1000,Cash,BALANCE_SHEET,DEBIT,yes,true,CASH"]);
  const out = await loadAccountsFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "monetary_flag"));
  }
  assert.equal(await app.masterData.questions.getAccount(tenantId, "MAIN", "1000", D1), null);
});

dbTest("accounts: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  const text = accountsCsv(["MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,MISSING"]);
  const out = await loadAccountsFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "REFUSED");
  if (out.kind === "REFUSED") assert.match(out.message, /hierarchy node|change set is invalid/i);
  assert.equal(await app.masterData.questions.getAccount(tenantId, "MAIN", "1000", D1), null);
});

// --- calendars ---

dbTest("calendars: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = calendarsCsv(["USD,SAT|SUN,2027-12-31,2026-01-01,NY", "USD,SAT|SUN,2027-12-31,2026-07-04,July4"]);
  const opts = { tenantId, text, sourceSystem: "md", asOf: D1, mode: "SNAPSHOT" as const, by };
  const first = await loadCalendarsFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") assert.equal(first.status, "APPLIED");
  const got = await app.masterData.questions.getCalendars(tenantId, ["USD"], D1);
  assert.equal(got[0]?.holidays.length, 2);
  const second = await loadCalendarsFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("calendars: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = calendarsCsv([
    "USD,SAT|SUN,2027-12-31,2026-01-01,NY",
    "USD,FRI|SAT,2027-12-31,2026-07-04,July4",
  ]);
  const out = await loadCalendarsFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 2 && p.column === "weekend_days"));
  }
  assert.equal((await app.masterData.questions.getCalendars(tenantId, ["USD"], D1)).length, 0);
});

dbTest("calendars: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  // Shape-valid dates; service refuses holiday after covered_through.
  const text = calendarsCsv(["USD,SAT|SUN,2026-12-31,2027-01-01,NewYear"]);
  const out = await loadCalendarsFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(out.kind, "REFUSED");
  if (out.kind === "REFUSED") assert.match(out.message, /covered-through|change set is invalid/i);
  assert.equal((await app.masterData.questions.getCalendars(tenantId, ["USD"], D1)).length, 0);
});

// --- exposure currencies ---

dbTest("exposure-currencies: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = exposureCsv(["EUR-USD,USD", "GBP-USD,GBP"]);
  const opts = {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT" as const,
    by,
    programCode: "BS",
  };
  const first = await loadExposureCurrenciesFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") assert.equal(first.status, "APPLIED");
  const pairs = await app.masterData.questions.getPairExposureCurrencies(tenantId, programId("BS"), D1);
  assert.equal(pairs.length, 2);
  const second = await loadExposureCurrenciesFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("exposure-currencies: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = exposureCsv(["EURUSD,USD"]);
  const out = await loadExposureCurrenciesFile(app, {
    tenantId,
    text,
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
    programCode: "BS",
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "pair"));
  }
  assert.deepEqual(await app.masterData.questions.getPairExposureCurrencies(tenantId, programId("BS"), D1), []);
});

dbTest("exposure-currencies: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  await loadExposureCurrenciesFile(app, {
    tenantId,
    text: exposureCsv(["EUR-USD,USD"]),
    sourceSystem: "md",
    asOf: D2,
    mode: "SNAPSHOT",
    by,
    programCode: "BS",
  });
  const refused = await loadExposureCurrenciesFile(app, {
    tenantId,
    text: exposureCsv(["GBP-USD,GBP"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
    programCode: "BS",
  });
  assert.equal(refused.kind, "REFUSED");
  if (refused.kind === "REFUSED") assert.match(refused.message, /rewrite history/);
  assert.deepEqual(await app.masterData.questions.getPairExposureCurrencies(tenantId, programId("BS"), D1), []);
});

// --- GL ---

dbTest("gl: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const text = glCsv(["US1,1000,USD,125000.50,,,2026-03-09", "US1,1000,EUR,10000.00,,,2026-03-09"]);
  const opts = { tenantId, text, chartCode: "MAIN", asOf: D1, sourceSystem: "erp", by };
  const first = await loadGlFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") {
    assert.equal(first.status, "APPLIED");
    assert.equal(first.counts.received, 2);
  }
  const status = await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 });
  assert.equal(status.length, 1);
  assert.equal(status[0]?.received, 2);
  const second = await loadGlFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("gl: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const text = glCsv(["US1,1000,USD,10.00,,,2026-03-09", "US1,1000,USD,,,,2026-03-09"]);
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 2 && p.column === "balance"));
  }
  assert.deepEqual(await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 }), []);
});

dbTest("gl: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const empty = await loadGlFile(app, {
    tenantId,
    text: "entity_code,account_number,currency,balance,debit,credit,as_of\n",
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  assert.equal(empty.kind, "REFUSED");
  if (empty.kind === "REFUSED") assert.match(empty.message, /no rows/);
  const failed = await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 });
  assert.ok(failed.every((b) => b.status === "FAILED" || b.received === 0));
  // A FAILED empty batch is recorded, but no balance rows are stored.
  assert.equal(failed.filter((b) => b.status !== "FAILED").length, 0);
});

dbTest("gl: E3 gl-malformed.csv → INVALID_FILE, 40 planted problems, nothing stored", async () => {
  const packDir = await ensureE3Pack();
  const tenantId = await newTenant();
  await seedFromE3Pack(tenantId, packDir);
  const text = await readFile(join(packDir, "gl-malformed.csv"), "utf8");
  const expected = JSON.parse(
    await readFile(join(REPO_ROOT, "packs/uat/expected/gl-malformed-problems.json"), "utf8"),
  ) as { problems: { row: number; column: string; kind: string }[]; expectedExitCode: number };
  assert.equal(expected.problems.length, 40);
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: E3_CHART,
    asOf: E3_GL_ASOF,
    sourceSystem: "erp",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind !== "INVALID_FILE") return;
  assert.deepEqual(
    out.problems.map((p) => [p.rowNo, p.column]),
    expected.problems.map((p) => [p.row, p.column]),
  );
  assert.deepEqual(
    await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: E3_GL_ASOF }),
    [],
  );
}, { timeout: 300_000 });

dbTest("gl: E3 gl-dirty.csv → APPLIED, all 20,000 rows stored (service issues are E's)", async () => {
  const packDir = await ensureE3Pack();
  const tenantId = await newTenant();
  await seedFromE3Pack(tenantId, packDir);
  const text = await readFile(join(packDir, "gl-dirty.csv"), "utf8");
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: E3_CHART,
    asOf: E3_GL_ASOF,
    sourceSystem: "erp",
    by,
  });
  assert.equal(out.kind, "DONE");
  if (out.kind !== "DONE") return;
  assert.equal(out.status, "APPLIED");
  assert.equal(out.counts.received, 20_000);
  const status = await app.dataSource.questions.ingestionStatus(tenantId, {
    sourceSystem: "erp",
    asOf: E3_GL_ASOF,
  });
  assert.equal(status[0]?.received, 20_000);
}, { timeout: 300_000 });

dbTest("gl: 20,000-row load under 60 seconds (report stage if slower)", async () => {
  const tenantId = await newTenant();
  // Enough distinct entities and accounts for 20k unique keys.
  await loadCurrenciesFile(app, {
    tenantId,
    text: currenciesCsv(["USD,false"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  const entityRows = ["G,Group,GROUP,,,,false,false,false"];
  for (let i = 1; i <= 50; i++) {
    entityRows.push(
      `E${String(i).padStart(2, "0")},Entity ${i},BUSINESS_UNIT,G,,,false,false,false`,
    );
  }
  await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv(entityRows),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  await loadHierarchyFile(app, {
    tenantId,
    text: hierarchyCsv(["MAIN,CASH,Cash,ASSETS,"]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  const accountRows: string[] = [];
  for (let i = 0; i < 400; i++) {
    accountRows.push(`MAIN,${1000 + i},Acct ${i},BALANCE_SHEET,DEBIT,true,true,CASH`);
  }
  await loadAccountsFile(app, {
    tenantId,
    text: accountsCsv(accountRows),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });

  const text = buildGlValid20k();

  // Diagnostics: parser alone (no DB). Service/database ≈ full path minus parse.
  const parseStarted = performance.now();
  const parsed = parseGlFile(text);
  const parseMs = performance.now() - parseStarted;
  assert.equal(parsed.problems.length, 0);
  assert.equal(parsed.rows.length, 20_000);

  // D6 limit is on the real loader path, not its pieces alone.
  const loadStarted = performance.now();
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  const loadMs = performance.now() - loadStarted;
  const serviceMs = Math.max(0, loadMs - parseMs);
  console.log(
    "D6 20k GL TIMINGS (ms):\n" +
      `  parse (diagnostic): ${parseMs.toFixed(1)}\n` +
      `  service/database (diagnostic ≈ load − parse): ${serviceMs.toFixed(1)}\n` +
      `  loadGlFile (full path): ${loadMs.toFixed(1)}`,
  );

  assert.equal(out.kind, "DONE");
  if (out.kind === "DONE") {
    assert.equal(out.status, "APPLIED");
    assert.equal(out.counts.received, 20_000);
  }
  assert.ok(
    loadMs < 60_000,
    `20k loadGlFile took ${(loadMs / 1000).toFixed(1)}s (limit 60s); parse=${parseMs.toFixed(1)}ms, service/database≈${serviceMs.toFixed(1)}ms, loadGlFile=${loadMs.toFixed(1)}ms. File an issue with these measurements; do not tune Data Source in stream D.`,
  );
}, { timeout: 180_000 });

// --- rates ---

dbTest("rates: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  const text = ratesCsv([
    "EUR,USD,SPOT,SPOT,,1.0850000000,,,,,,2026-03-09T16:30:00Z",
    "GBP,USD,SPOT,SPOT,,1.2700000000,,,,,,2026-03-09T16:30:00Z",
  ]);
  const opts = { tenantId, text, source: "reuters", businessDate: D1, by };
  const first = await loadRatesFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") {
    assert.equal(first.status, "APPLIED");
    assert.equal(first.counts.accepted, 2);
  }
  assert.ok(await app.fxRate.questions.getRate({ tenantId, base: "EUR", quote: "USD", asOf: D1 }));
  const second = await loadRatesFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("rates: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  // Trailing empty observed_at (12 columns); shape problem names the column.
  const text = ratesCsv(["EUR,USD,SPOT,SPOT,,1.08,,,,,,"]);
  const out = await loadRatesFile(app, {
    tenantId,
    text,
    source: "reuters",
    businessDate: D1,
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "observed_at"), JSON.stringify(out.problems));
  }
  assert.equal(
    await app.fxRate.questions.getRate({ tenantId, base: "EUR", quote: "USD", asOf: D1 }),
    null,
  );
});

dbTest("rates: service REFUSED stores nothing", async () => {
  const tenantId = await newTenant();
  const text = ratesCsv(["EUR,USD,SPOT,SPOT,,1.0850000000,,,,,,2026-03-09T16:30:00Z"]);
  const out = await loadRatesFile(app, {
    tenantId,
    text,
    source: "bad source!",
    businessDate: D1,
    by,
  });
  assert.equal(out.kind, "REFUSED");
  if (out.kind === "REFUSED") assert.match(out.message, /rate load is invalid|source/);
  assert.equal(
    await app.fxRate.questions.getRate({ tenantId, base: "EUR", quote: "USD", asOf: D1 }),
    null,
  );
});

// --- executed ---

dbTest("executed: valid stores, same file is DUPLICATE", async () => {
  const tenantId = await newTenant();
  await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv([
      "G,Group,GROUP,,,,false,false,false",
      "US1,Acme US,LEGAL_ENTITY,G,US,USD,true,true,true",
    ]),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  const text = executedCsv([
    "SIM-1,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,1000000.0000,USD,1090000.0000,,FORWARD,BUY,BOOK-A,,,",
  ]);
  const opts = { tenantId, text, by };
  const first = await loadExecutedFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") {
    assert.equal(first.status, "APPLIED");
    assert.ok((first.counts.stored ?? 0) + (first.counts.unchanged ?? 0) >= 1 || first.counts.received === 1);
  }
  const open = await app.fxTrade.questions.unmatchedTrades(tenantId);
  assert.ok(open.length >= 1);
  const second = await loadExecutedFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind === "DONE") assert.equal(second.status, "DUPLICATE");
});

dbTest("executed: one bad row is INVALID_FILE and stores nothing", async () => {
  const tenantId = await newTenant();
  const text = [
    executedHeader,
    'SIM-1,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,"10"0,USD,1090,,FORWARD,BUY,BOOK-A,,,',
  ].join("\n");
  const out = await loadExecutedFile(app, { tenantId, text, by });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind === "INVALID_FILE") {
    assert.ok(out.problems.some((p) => p.rowNo === 1));
  }
  assert.deepEqual(await app.fxTrade.questions.unmatchedTrades(tenantId), []);
});

// --- HELD (Master Data snapshot safeguard; still part of the path) ---

dbTest("entities: HELD snapshot safeguard stores nothing new", async () => {
  const tenantId = await newTenant();
  const codes = Array.from({ length: 20 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`);
  await app.masterData.commands.setMaxEndShare(tenantId, 0);
  const first = await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv(codes.map((c) => `${c},${c},BUSINESS_UNIT,,,,false,false,false`)),
    sourceSystem: "erp",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(first.kind, "DONE");
  const held = await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv(codes.slice(0, 10).map((c) => `${c},${c},BUSINESS_UNIT,,,,false,false,false`)),
    sourceSystem: "erp",
    asOf: D2,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(held.kind, "HELD");
  if (held.kind === "HELD") assert.match(held.reason, /would end/);
  assert.equal((await app.masterData.questions.getEntity(tenantId, "E20", D2))?.code, "E20");
});

// --- CLI child process exit codes ---

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["app/src/cli/load.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

dbTest("CLI child process: exit 0 APPLIED, 0 DUPLICATE, 1 INVALID_FILE, 2 REFUSED", async () => {
  const tenantId = await newTenant();
  const dir = await mkdtemp(join(tmpdir(), "d6-cli-"));
  const good = join(dir, "currencies.csv");
  const bad = join(dir, "currencies-bad.csv");
  await writeFile(good, `${currenciesCsv(["USD,false", "EUR,false"])}\n`);
  await writeFile(bad, `${currenciesCsv(["US,false"])}\n`);

  const base = [
    "currencies",
    good,
    "--tenant",
    tenantId,
    "--source",
    "md",
    "--as-of",
    "2026-03-09",
    "--mode",
    "SNAPSHOT",
    "--by",
    "cli-d6",
  ];
  const env = { DATABASE_URL: url };

  const applied = await runCli(base, env);
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /APPLIED/);

  const dup = await runCli(base, env);
  assert.equal(dup.code, 0, dup.stdout + dup.stderr);
  assert.match(dup.stdout, /DUPLICATE/);

  const invalid = await runCli(
    ["currencies", bad, "--tenant", tenantId, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--by", "cli-d6"],
    env,
  );
  assert.equal(invalid.code, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /INVALID_FILE/);
  assert.match(invalid.stdout, /row 1/);

  // REFUSED: rewrite history — later date first, then earlier date with different content.
  const later = join(dir, "currencies-later.csv");
  await writeFile(later, `${currenciesCsv(["GBP,false"])}\n`);
  const early = join(dir, "currencies-early.csv");
  await writeFile(early, `${currenciesCsv(["JPY,false"])}\n`);
  const t2 = await newTenant();
  const appliedLater = await runCli(
    [
      "currencies",
      later,
      "--tenant",
      t2,
      "--source",
      "md",
      "--as-of",
      "2026-03-10",
      "--mode",
      "SNAPSHOT",
      "--by",
      "cli-d6",
    ],
    env,
  );
  assert.equal(appliedLater.code, 0, appliedLater.stdout + appliedLater.stderr);
  const refused = await runCli(
    [
      "currencies",
      early,
      "--tenant",
      t2,
      "--source",
      "md",
      "--as-of",
      "2026-03-09",
      "--mode",
      "SNAPSHOT",
      "--by",
      "cli-d6",
    ],
    env,
  );
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /REFUSED/);
});

dbTest("CLI child process: E3 gl-malformed.csv exits 1, names all 40 problems, stores nothing", async () => {
  const packDir = await ensureE3Pack();
  const tenantId = await newTenant();
  await seedFromE3Pack(tenantId, packDir);
  const expected = JSON.parse(
    await readFile(join(REPO_ROOT, "packs/uat/expected/gl-malformed-problems.json"), "utf8"),
  ) as { problems: { row: number; column: string }[]; expectedExitCode: number };
  const file = join(packDir, "gl-malformed.csv");

  const result = await runCli(
    [
      "gl",
      file,
      "--tenant",
      tenantId,
      "--chart",
      E3_CHART,
      "--as-of",
      E3_GL_ASOF,
      "--source",
      "erp",
      "--by",
      "cli-d6",
    ],
    { DATABASE_URL: url },
  );
  assert.equal(result.code, expected.expectedExitCode, result.stdout + result.stderr);
  assert.match(result.stdout, /INVALID_FILE/);
  // CLI caps problem lines at 50; all 40 planted diagnostics fit.
  for (const p of expected.problems) {
    assert.match(result.stdout, new RegExp(`row ${p.row}, column ${p.column}:`));
  }
  assert.deepEqual(
    await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: E3_GL_ASOF }),
    [],
  );
}, { timeout: 300_000 });

dbTest("CLI child process: E3 gl-dirty.csv exits 0 APPLIED and stores 20,000 rows", async () => {
  const packDir = await ensureE3Pack();
  const tenantId = await newTenant();
  await seedFromE3Pack(tenantId, packDir);
  const file = join(packDir, "gl-dirty.csv");
  const result = await runCli(
    [
      "gl",
      file,
      "--tenant",
      tenantId,
      "--chart",
      E3_CHART,
      "--as-of",
      E3_GL_ASOF,
      "--source",
      "erp",
      "--by",
      "cli-d6",
    ],
    { DATABASE_URL: url },
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /APPLIED/);
  const status = await app.dataSource.questions.ingestionStatus(tenantId, {
    sourceSystem: "erp",
    asOf: E3_GL_ASOF,
  });
  assert.equal(status[0]?.received, 20_000);
}, { timeout: 300_000 });

dbTest("CLI child process: one successful load per kind", async () => {
  clock.now = new Date("2026-03-10T12:00:00Z");
  const tenantId = await newTenant();
  const dir = await mkdtemp(join(tmpdir(), "d6-cli-kinds-"));
  const env = { DATABASE_URL: url };
  const write = async (name: string, body: string) => {
    const path = join(dir, name);
    await writeFile(path, `${body}\n`);
    return path;
  };

  const currencies = await write("currencies.csv", currenciesCsv(["USD,false", "EUR,false"]));
  const entities = await write(
    "entities.csv",
    entitiesCsv([
      "G,Group,GROUP,,,,false,false,false",
      "US1,Acme US,LEGAL_ENTITY,G,US,USD,true,true,true",
    ]),
  );
  const hierarchy = await write("hierarchy.csv", hierarchyCsv(["MAIN,CASH,Cash,ASSETS,"]));
  const accounts = await write(
    "accounts.csv",
    accountsCsv(["MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,CASH"]),
  );
  const calendars = await write(
    "calendars.csv",
    calendarsCsv(["USD,SAT|SUN,2027-12-31,2026-01-01,NY"]),
  );
  const exposure = await write("exposure-currencies.csv", exposureCsv(["EUR-USD,USD"]));
  const gl = await write("gl.csv", glCsv(["US1,1000,USD,100.00,,,2026-03-09"]));
  const rates = await write(
    "rates.csv",
    ratesCsv(["EUR,USD,SPOT,SPOT,,1.0850000000,,,,,,2026-03-09T16:30:00Z"]),
  );
  const executed = await write(
    "executed.csv",
    executedCsv([
      "SIM-CLI,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,1000.0000,USD,1090.0000,,FORWARD,BUY,BOOK-A,,,",
    ]),
  );

  const mdFlags = ["--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--by", "cli-d6"];
  const kinds: { args: string[]; label: string }[] = [
    { label: "currencies", args: ["currencies", currencies, "--tenant", tenantId, ...mdFlags] },
    { label: "entities", args: ["entities", entities, "--tenant", tenantId, ...mdFlags] },
    { label: "hierarchy", args: ["hierarchy", hierarchy, "--tenant", tenantId, ...mdFlags] },
    { label: "accounts", args: ["accounts", accounts, "--tenant", tenantId, ...mdFlags] },
    { label: "calendars", args: ["calendars", calendars, "--tenant", tenantId, ...mdFlags] },
    {
      label: "exposure-currencies",
      args: ["exposure-currencies", exposure, "--tenant", tenantId, ...mdFlags, "--program", "BS"],
    },
    {
      label: "gl",
      args: [
        "gl",
        gl,
        "--tenant",
        tenantId,
        "--chart",
        "MAIN",
        "--as-of",
        "2026-03-09",
        "--source",
        "erp",
        "--by",
        "cli-d6",
      ],
    },
    {
      label: "rates",
      args: [
        "rates",
        rates,
        "--tenant",
        tenantId,
        "--source",
        "reuters",
        "--business-date",
        "2026-03-09",
        "--by",
        "cli-d6",
      ],
    },
    { label: "executed", args: ["executed", executed, "--tenant", tenantId, "--by", "cli-d6"] },
  ];

  for (const { label, args } of kinds) {
    const result = await runCli(args, env);
    assert.equal(result.code, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /APPLIED|DUPLICATE/, `${label}: ${result.stdout}`);
  }
}, { timeout: 120_000 });
