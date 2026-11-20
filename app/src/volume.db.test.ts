// The runtime at the UAT size: 50 entities, 40 currencies, one daily batch of 20,000 GL balance rows, driven by the runtime's own ticks.
// Skipped unless VOLUME_TEST=1 (it is slow). Needs TEST_DATABASE_URL (name ends in _test). Prints the time of each stage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { asOfDate, programId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { startRuntime } from "./runtime.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url) && process.env.VOLUME_TEST === "1";
if (!enabled) console.warn("volume test SKIPPED: set VOLUME_TEST=1 and TEST_DATABASE_URL to a database whose name ends in _test");

const CURRENCIES = "USD EUR GBP JPY CHF CAD AUD NZD SEK NOK DKK PLN CZK HUF RON TRY ZAR MXN BRL CLP COP PEN ARS INR CNY HKD SGD KRW TWD THB MYR IDR PHP VND AED SAR ILS EGP KES NGN".split(" ");
const SCHEMAS = ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"];

test("a 20,000-row cycle over 45 legal entities and 40 currencies completes through the runtime's ticks", { skip: !enabled, timeout: 1_800_000 }, async () => {
  assert.equal(CURRENCIES.length, 40);
  const clock = { now: new Date("2026-11-11T23:00:00Z") };
  const captured: string[] = [];
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of SCHEMAS) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await client.end();
  const runtime = await startRuntime(loadConfig({ DATABASE_URL: url, PORT: "0", TIMER_ENABLED: "false" }), createLogger("info", (l) => captured.push(l)), { now: () => clock.now });
  const { app } = runtime;
  const times: [string, number][] = [];
  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const began = Date.now();
    const out = await fn();
    times.push([stage, Date.now() - began]);
    return out;
  };
  try {
    const tenant = await app.identity.commands.createTenant("Volume");
    const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
    await app.identity.commands.enableProgram(tenant, programId("BS"), ops);
    const adminId = await app.identity.commands.addUser(tenant, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ADMIN"] }, ops);
    const admin: Actor = { kind: "user", userId: adminId };
    await app.exposureManagement.commands.defineProgram({
      tenantId: tenant, programId: "BS", name: "Daily balance sheet", type: "BALANCE_SHEET", effectiveFrom: "2026-01-01", actor: admin,
      settings: { nettingLevel: "ENTITY", bucketScheme: { kind: "MONTHS" }, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } },
    });

    // Master data: a group, 4 regions, 45 legal entities (50 records), 40 currencies, one chart of 50 accounts.
    const entity = (code: string, over: object = {}) => ({ code, name: code, type: "BUSINESS_UNIT", parentCode: null, countryCode: null, functionalCurrency: null, isLegalEntity: false, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over });
    const regions = ["AMER", "EMEA", "APAC", "LATM"];
    const legal = Array.from({ length: 45 }, (_, i) => `LE${String(i + 1).padStart(2, "0")}`);
    const entities = [
      entity("G"), ...regions.map((r) => entity(r, { type: "REGION", parentCode: "G" })),
      ...legal.map((code, i) => entity(code, { type: "LEGAL_ENTITY", isLegalEntity: true, functionalCurrency: CURRENCIES[i % 40], parentCode: regions[i % 4], countryCode: "US", isHedgeExecutionEntity: i === 0 })),
    ];
    assert.equal(entities.length, 50);
    const accounts = Array.from({ length: 50 }, (_, i) => ({ chartCode: "C", accountNumber: String(4000 + i), name: `Account ${i}`, statementType: "BALANCE_SHEET", normalBalance: "DEBIT", monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode: "1" }));
    const md = (kind: "applyEntities" | "applyHierarchy" | "applyAccounts" | "applyCurrencies", rows: unknown[]) =>
      app.masterData.commands[kind]({ tenantId: tenant, sourceSystem: "erp", asOf: asOfDate("2026-01-01"), mode: "SNAPSHOT", rows: rows as never, by: "volume" });
    await timed("master data", async () => {
      await md("applyEntities", entities);
      await md("applyHierarchy", [{ chartCode: "C", code: "1", name: "Assets", classification: "ASSETS", parentCode: null }]);
      await md("applyAccounts", accounts);
      await md("applyCurrencies", CURRENCIES.map((code) => ({ code, isNdf: ["BRL", "INR", "KRW", "TWD", "CLP", "ARS"].includes(code) })));
    });
    await runtime.delivery.runOnce();
    await app.dataSource.commands.addMappingRule({ tenantId: tenant, programId: "BS", kind: "INCLUDE", target: { type: "NODE", chartCode: "C", nodeCode: "1" }, validFrom: "2026-01-01", validTo: null, by: "volume" });

    await timed("rates", () => app.fxRate.commands.loadRates({
      tenantId: tenant, source: "bank", businessDate: asOfDate("2026-11-10"), by: "volume",
      rows: CURRENCIES.filter((c) => c !== "USD").map((c, i) => ({ base: c, quote: "USD", type: "SPOT" as const, tenor: "SPOT", valueDate: null, allIn: (0.5 + ((i * 37) % 900) / 1000).toFixed(6), spot: null, forwardPoints: null, bid: null, mid: null, ask: null, observedAt: clock.now.toISOString() })),
    }));

    // 45 entities x 9 currencies x 50 accounts = 20,250 candidates, cut to exactly 20,000 rows.
    const rows = legal.flatMap((code, e) => Array.from({ length: 9 }, (_, c) => CURRENCIES[(e + c * 4) % 40]!).flatMap((currency, c) =>
      accounts.map((a, k) => ({ entityCode: code, accountNumber: a.accountNumber, currency, balance: `${(k + c) % 3 === 0 ? "-" : ""}${1000 + ((e * 7919 + c * 104729 + k * 1291) % 90000)}.00`, debit: null, credit: null, asOf: null, dimensions: {} })))).slice(0, 20000);
    assert.equal(rows.length, 20000);
    assert.equal(new Set(rows.map((r) => `${r.entityCode}|${r.accountNumber}|${r.currency}`)).size, 20000, "every row is a distinct balance");
    const batch = await timed("GL batch of 20,000 rows", () => app.dataSource.commands.submitGlBatch({ tenantId: tenant, sourceSystem: "erp", chartCode: "C", asOf: asOfDate("2026-11-10"), rows, by: "volume" }));
    assert.equal(batch.received, 20000);
    assert.equal(batch.blocked, 0);

    await timed("event delivery", () => runtime.delivery.runOnce());
    await timed("cycle start", () => runtime.cycles.runOnce());
    const cycleId = captured.map((l) => JSON.parse(l)).find((l) => l.msg === "cycle started")?.cycleId as string | undefined;
    assert.ok(cycleId, "the cycle tick started a cycle");
    let stage = "";
    await timed("run to completion", async () => {
      for (let i = 0; i < 20 && stage !== "COMPLETED"; i++) {
        await runtime.delivery.runOnce();
        stage = (await app.exposureManagement.questions.getCycle(tenant, cycleId as never))?.stage ?? "NONE";
      }
    });
    assert.equal(stage, "COMPLETED", "the cycle completed through the runtime's ticks");
    console.log("VOLUME TIMINGS (ms):\n" + times.map(([s, ms]) => `  ${s}: ${ms}`).join("\n"));
  } finally {
    await runtime.shutdown(5000);
  }
});
