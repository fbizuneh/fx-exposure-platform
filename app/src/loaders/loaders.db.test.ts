// Loader outcomes against a real database: DONE, HELD, REFUSED. Needs TEST_DATABASE_URL (*_test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { asOfDate, type TenantId } from "@shared/kernel";
import { migrate } from "../../../scripts/migrate.mjs";
import { composeApp, type App } from "../compose.ts";
import { loadCurrenciesFile, loadEntitiesFile, loadGlFile, loadRatesFile } from "./index.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("loader database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

const clock = { now: new Date("2026-03-10T12:00:00Z") };
let app: App;

before(async () => {
  if (!enabled) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"]) {
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
const entitiesCsv = (codes: string[]) =>
  [
    "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity",
    ...codes.map((c) => `${c},${c},BUSINESS_UNIT,,,,false,false,false`),
  ].join("\n");

dbTest("DONE: APPLIED then DUPLICATE with service counts", async () => {
  const tenantId = await newTenant();
  const text = currenciesCsv(["USD,false", "EUR,false"]);
  const opts = { tenantId, text, sourceSystem: "md", asOf: D1, mode: "SNAPSHOT" as const, by };

  const first = await loadCurrenciesFile(app, opts);
  assert.equal(first.kind, "DONE");
  if (first.kind !== "DONE") return;
  assert.equal(first.status, "APPLIED");
  assert.deepEqual(first.counts, { created: 2, changed: 0, ended: 0, unchanged: 0 });

  const second = await loadCurrenciesFile(app, opts);
  assert.equal(second.kind, "DONE");
  if (second.kind !== "DONE") return;
  assert.equal(second.status, "DUPLICATE");
  assert.deepEqual(second.counts, { created: 0, changed: 0, ended: 0, unchanged: 0 });
});

dbTest("HELD: Master Data snapshot safeguard", async () => {
  const tenantId = await newTenant();
  const codes = Array.from({ length: 20 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`);
  await app.masterData.commands.setMaxEndShare(tenantId, 0);

  const first = await loadEntitiesFile(app, {
    tenantId, text: entitiesCsv(codes), sourceSystem: "erp", asOf: D1, mode: "SNAPSHOT", by,
  });
  assert.equal(first.kind, "DONE");
  if (first.kind === "DONE") assert.equal(first.status, "APPLIED");

  const held = await loadEntitiesFile(app, {
    tenantId, text: entitiesCsv(codes.slice(0, 10)), sourceSystem: "erp", asOf: D2, mode: "SNAPSHOT", by,
  });
  assert.equal(held.kind, "HELD");
  if (held.kind !== "HELD") return;
  assert.ok(held.batchId.length > 0);
  assert.match(held.reason, /would end/);
  assert.equal((await app.masterData.questions.getEntity(tenantId, "E20", D2))?.code, "E20", "nothing applied while held");
});

dbTest("REFUSED: BatchRefused, ChangeSetInvalid, ChangeSetRefused, RatesInvalid", async () => {
  const tenantId = await newTenant();

  const emptyGl = await loadGlFile(app, {
    tenantId,
    text: "entity_code,account_number,currency,balance,debit,credit,as_of\n",
    chartCode: "MAIN",
    asOf: D1,
    sourceSystem: "erp",
    by,
  });
  assert.equal(emptyGl.kind, "REFUSED");
  if (emptyGl.kind === "REFUSED") assert.match(emptyGl.message, /no rows/);

  const badEntity = await loadEntitiesFile(app, {
    tenantId,
    text: [
      "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity",
      "US1,Acme US,LEGAL_ENTITY,,US,,true,false,false",
    ].join("\n"),
    sourceSystem: "md",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(badEntity.kind, "REFUSED");
  if (badEntity.kind === "REFUSED") assert.match(badEntity.message, /functional currency|change set is invalid/i);

  await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv(["G"]),
    sourceSystem: "erp",
    asOf: D2,
    mode: "SNAPSHOT",
    by,
  });
  const rewrite = await loadEntitiesFile(app, {
    tenantId,
    text: entitiesCsv(["G", "H"]),
    sourceSystem: "erp",
    asOf: D1,
    mode: "SNAPSHOT",
    by,
  });
  assert.equal(rewrite.kind, "REFUSED");
  if (rewrite.kind === "REFUSED") assert.match(rewrite.message, /rewrite history/);

  // Shape-valid file; service refuses the source code (RatesInvalid).
  const badRates = await loadRatesFile(app, {
    tenantId,
    text: [
      "base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at",
      "EUR,USD,SPOT,SPOT,,1.0850000000,,,,,,2026-03-09T16:30:00Z",
    ].join("\n"),
    source: "bad source!",
    businessDate: D1,
    by,
  });
  assert.equal(badRates.kind, "REFUSED");
  if (badRates.kind === "REFUSED") assert.match(badRates.message, /rate load is invalid|source/);
});
