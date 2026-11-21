// D6: full loader path through composeApp. Needs TEST_DATABASE_URL (*_test).
// Per loader: valid → stores; same file → DUPLICATE; one bad row → INVALID_FILE, nothing stored;
// service refusal → REFUSED, nothing stored. CLI child-process exit codes. 20k GL under 60s.
// E3 gl-malformed / gl-dirty CSVs are gitignored; this file builds equivalent fixtures matching packs/uat/expected/.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { asOfDate, programId, type TenantId } from "@shared/kernel";
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
});

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

/** Equivalent of packs/uat/expected/gl-malformed-problems.json planted kinds (E3 CSVs are gitignored). */
const MALFORMED_KINDS = [
  "balance_with_debit",
  "no_amount",
  "bad_date",
  "bad_currency",
  "non_numeric",
  "missing_entity",
] as const;
const MALFORMED_COLUMNS: Record<(typeof MALFORMED_KINDS)[number], string> = {
  balance_with_debit: "balance",
  no_amount: "balance",
  bad_date: "as_of",
  bad_currency: "currency",
  non_numeric: "balance",
  missing_entity: "entity_code",
};

function buildGlMalformedEquivalent(rowCount = 20_000): {
  text: string;
  expected: { row: number; column: string; kind: string }[];
} {
  const header = "entity_code,account_number,currency,balance,debit,credit,as_of,cost_center";
  const lines = [header];
  const expected: { row: number; column: string; kind: string }[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row = [
      "US1",
      "1000",
      "USD",
      `${(1000 + (i % 9000)).toFixed(2)}`,
      "",
      "",
      "2026-03-09",
      `CC-${(i % 10) + 1}`,
    ];
    if (i < 40) {
      const kind = MALFORMED_KINDS[i % MALFORMED_KINDS.length]!;
      if (kind === "balance_with_debit") row[4] = "1.00";
      if (kind === "no_amount") row[3] = "";
      if (kind === "bad_date") row[6] = "2026-99-99";
      if (kind === "bad_currency") row[2] = "EURO";
      if (kind === "non_numeric") row[3] = "NaN";
      if (kind === "missing_entity") row[0] = "";
      expected.push({ row: i + 1, column: MALFORMED_COLUMNS[kind], kind });
    }
    lines.push(row.join(","));
  }
  return { text: `${lines.join("\n")}\n`, expected };
}

/** Parser-valid dirty GL: unknown entity/account/excluded-account plants; every row loader-accepted. */
function buildGlDirtyEquivalent(rowCount = 20_000): string {
  const header = "entity_code,account_number,currency,balance,debit,credit,as_of,cost_center";
  const lines = [header];
  for (let i = 0; i < rowCount; i++) {
    let entity = "US1";
    let account = "1000";
    if (i < 10) entity = `UNKNOWN${i + 1}`;
    else if (i < 20) account = `UNKNOWN${i + 1}`;
    else if (i < 30) account = "8009";
    lines.push(
      [
        entity,
        account,
        "USD",
        `${(1000 + (i % 9000)).toFixed(2)}`,
        "",
        "",
        "2026-03-09",
        `CC-${(i % 10) + 1}`,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
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

dbTest("gl: E3-equivalent malformed → INVALID_FILE, planted problems, nothing stored", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const { text, expected } = buildGlMalformedEquivalent(20_000);
  const packExpected = JSON.parse(
    await readFile(join(REPO_ROOT, "packs/uat/expected/gl-malformed-problems.json"), "utf8"),
  ) as { problems: { row: number; column: string; kind: string }[] };
  assert.deepEqual(
    expected.map((p) => ({ row: p.row, column: p.column, kind: p.kind })),
    packExpected.problems,
    "equivalent fixture matches packs/uat/expected/gl-malformed-problems.json",
  );
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  assert.equal(out.kind, "INVALID_FILE");
  if (out.kind !== "INVALID_FILE") return;
  assert.deepEqual(
    out.problems.map((p) => [p.rowNo, p.column]),
    expected.map((p) => [p.row, p.column]),
  );
  assert.deepEqual(await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 }), []);
});

dbTest("gl: E3-equivalent dirty → APPLIED, every row stored (service issues are E's)", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const text = buildGlDirtyEquivalent(20_000);
  const out = await loadGlFile(app, {
    tenantId,
    text,
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  assert.equal(out.kind, "DONE");
  if (out.kind !== "DONE") return;
  assert.equal(out.status, "APPLIED");
  assert.equal(out.counts.received, 20_000);
  const packDirty = JSON.parse(
    await readFile(join(REPO_ROOT, "packs/uat/expected/gl-dirty-plants.json"), "utf8"),
  ) as { storedRows: number; expectedLoadStatus: string };
  assert.equal(out.counts.received, packDirty.storedRows);
  assert.equal(out.status, packDirty.expectedLoadStatus);
  const status = await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 });
  assert.equal(status[0]?.received, 20_000);
}, { timeout: 120_000 });

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
  const stages: { stage: string; ms: number }[] = [];
  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    stages.push({ stage, ms: performance.now() - t0 });
    return out;
  };

  const t0 = performance.now();
  const out = await timed("loadGlFile (parse + submitGlBatch)", () =>
    loadGlFile(app, {
      tenantId,
      text,
      chartCode: "MAIN",
      asOf: D1,
      sourceSystem: "erp",
      by,
    }),
  );
  const totalMs = performance.now() - t0;
  stages.push({ stage: "total", ms: totalMs });
  console.log(
    "D6 20k GL TIMINGS (ms):\n" + stages.map((s) => `  ${s.stage}: ${s.ms.toFixed(1)}`).join("\n"),
  );

  assert.equal(out.kind, "DONE");
  if (out.kind === "DONE") {
    assert.equal(out.status, "APPLIED");
    assert.equal(out.counts.received, 20_000);
  }

  if (totalMs >= 60_000) {
    const slowest = [...stages].sort((a, b) => b.ms - a.ms)[0]!;
    const body = [
      "D6 20k GL load exceeded 60 seconds.",
      "",
      "Stages (ms):",
      ...stages.map((s) => `- ${s.stage}: ${s.ms.toFixed(1)}`),
      "",
      `Slowest stage: ${slowest.stage} (${slowest.ms.toFixed(1)} ms).`,
      "Do not tune Data Source in stream D; investigate parsing / loader path first.",
    ].join("\n");
    // Open an issue when gh is available; still fail the assertion with the stage named.
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "gh",
          [
            "issue",
            "create",
            "--repo",
            "fbizuneh/fx-exposure-platform",
            "--title",
            "D6: 20k GL load exceeded 60s",
            "--body",
            body,
          ],
          { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (c: Buffer) => {
          err += c.toString();
        });
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `gh exit ${code}`))));
      });
      console.warn("Opened GitHub issue for slow 20k GL load");
    } catch (e) {
      console.warn("Could not open GitHub issue for slow 20k GL load:", e);
    }
    assert.fail(
      `20k GL load took ${(totalMs / 1000).toFixed(1)}s (limit 60s); slowest stage: ${slowest.stage} (${slowest.ms.toFixed(1)}ms)`,
    );
  }
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

dbTest("CLI child process: E3-equivalent malformed GL exits 1, names problems, stores nothing", async () => {
  const tenantId = await newTenant();
  await seedGlMaster(tenantId);
  const dir = await mkdtemp(join(tmpdir(), "d6-gl-malformed-"));
  const { text, expected } = buildGlMalformedEquivalent(20_000);
  const file = join(dir, "gl-malformed.csv");
  await writeFile(file, text);

  const result = await runCli(
    [
      "gl",
      file,
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
    { DATABASE_URL: url },
  );
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /INVALID_FILE/);
  // CLI caps at 50 problem lines; first 40 planted problems should appear (or 50 of summary+lines).
  for (const p of expected.slice(0, 40)) {
    // Cap: summary + 50 lines; all 40 fit.
    assert.match(result.stdout, new RegExp(`row ${p.row}, column ${p.column}:`));
  }
  assert.deepEqual(
    await app.dataSource.questions.ingestionStatus(tenantId, { sourceSystem: "erp", asOf: D1 }),
    [],
  );
}, { timeout: 120_000 });
