// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// fx_rate schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import type { FxRateEvents } from "../contract/index.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, tenantId, type TenantId } from "@shared/kernel";
import { migrate } from "../../../scripts/migrate.mjs";
import { connect, createFxRate, RatesInvalid, type Db, type RateRow } from "./index.ts";
import { q } from "./db.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("fx rate database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

let db: Db;
let fx: ReturnType<typeof createFxRate>;
let clock = new Date("2026-03-10T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("fx_rate").ifExists().cascade().execute();
  await migrate(url!);
  fx = createFxRate(db, { now: () => clock });
});
after(async () => {
  if (enabled) await db.destroy();
});

const D1 = asOfDate("2026-03-05");
const D2 = asOfDate("2026-03-06");
const newTenant = () => tenantId(randomUUID());
const spot = (base: string, quote: string, allIn: string, over: Partial<RateRow> = {}): RateRow => ({
  base, quote, type: "SPOT", tenor: "SPOT", valueDate: null, allIn, spot: null, forwardPoints: null, bid: null, mid: null, ask: null,
  observedAt: "2026-03-05T21:00:00Z", ...over,
});
const fwd = (base: string, quote: string, tenor: string, spotRate: string, points: string, allIn: string): RateRow => ({
  ...spot(base, quote, allIn), type: "FORWARD", tenor, spot: spotRate, forwardPoints: points,
});
const send = (t: TenantId, rows: RateRow[], date = D1, source = "bank") => fx.commands.loadRates({ tenantId: t, source, businessDate: date, rows, by: "test" });
const ask = (t: TenantId, base: string, quote: string, over: { asOf?: typeof D1; tenor?: string; source?: string } = {}) =>
  fx.questions.getRate({ tenantId: t, base, quote, asOf: over.asOf ?? D1, ...(over.tenor ? { tenor: over.tenor } : {}), ...(over.source ? { source: over.source } : {}) });
const events = async (t: TenantId) => {
  const loaded: Extract<FxRateEvents, { type: "fx-rate.loaded" }>[] = []; // the announcement other services use; change records are checked in the Audit tests
  for (const e of await fx.outbox.pending(1000)) if (e.tenantId === t && e.type === "fx-rate.loaded") loaded.push(e);
  return loaded;
};

dbTest("direct, inverse and identity", async () => {
  const t = newTenant();
  const r = await send(t, [spot("EUR", "USD", "1.0800000000")]);
  assert.deepEqual([r.status, r.accepted, r.flagged], ["APPLIED", 1, 0]);
  const direct = await ask(t, "EUR", "USD");
  assert.deepEqual([direct?.rate, direct?.derivation, direct?.quality, direct?.source, direct?.loadIds], ["1.0800000000", "DIRECT", "VALID", "bank", [r.loadId]]);
  const inverse = await ask(t, "USD", "EUR");
  assert.deepEqual([inverse?.rate, inverse?.derivation], ["0.9259259259", "INVERSE"]);
  const same = await ask(t, "JPY", "JPY");
  assert.deepEqual([same?.rate, same?.derivation, same?.source, same?.loadIds], ["1.0000000000", "IDENTITY", null, []]);
  assert.equal(await ask(t, "EUR", "USD", { asOf: D2 }), null, "no fallback to an earlier day");
  assert.equal(await ask(t, "EUR", "GBP"), null);
  await assert.rejects(ask(t, "eur", "USD"), RangeError);
  await assert.rejects(ask(t, "EUR", "USD", { tenor: "monthly" }), RangeError);
});

dbTest("cross rates go through the pivot, in any orientation", async () => {
  const t = newTenant();
  await send(t, [spot("EUR", "USD", "1.1000000000"), spot("USD", "JPY", "150.0000000000"), spot("GBP", "USD", "1.2500000000")]);
  const eurJpy = await ask(t, "EUR", "JPY");
  assert.deepEqual([eurJpy?.rate, eurJpy?.derivation, eurJpy?.loadIds.length], ["165.0000000000", "CROSS", 1]);
  const gbpEur = await ask(t, "GBP", "EUR"); // GBP/USD direct, USD/EUR inverse
  assert.equal(gbpEur?.rate, "1.1363636364");
  assert.equal((await ask(t, "JPY", "EUR"))?.rate, "0.0060606061");
  assert.equal(await ask(t, "EUR", "CHF"), null, "a missing leg means no answer");
  await fx.commands.setPivotCurrency(t, "EUR");
  assert.equal(await ask(t, "GBP", "JPY"), null, "pivot is EUR now and GBP/EUR is not loaded");
  await assert.rejects(fx.commands.setPivotCurrency(t, "euro"), RangeError);
});

dbTest("forwards are looked up by tenor and never mix with spot", async () => {
  const t = newTenant();
  await send(t, [spot("EUR", "USD", "1.0850000000"), fwd("EUR", "USD", "3M", "1.0850000000", "0.0050000000", "1.0900000000")]);
  assert.equal((await ask(t, "EUR", "USD"))?.rate, "1.0850000000");
  assert.equal((await ask(t, "EUR", "USD", { tenor: "3M" }))?.rate, "1.0900000000");
  assert.equal(await ask(t, "EUR", "USD", { tenor: "6M" }), null);
  assert.equal((await ask(t, "USD", "EUR", { tenor: "3M" }))?.derivation, "INVERSE");
});

dbTest("a repeated load changes nothing; a corrected load for the same date is the latest", async () => {
  const t = newTenant();
  const first = await send(t, [spot("EUR", "USD", "1.0800000000")]);
  const again = await send(t, [spot("EUR", "USD", "1.0800000000")]);
  assert.deepEqual([again.status, again.loadId, again.accepted], ["DUPLICATE", first.loadId, 0]);
  assert.equal((await events(t)).length, 1, "one event, not two");
  const fix = await send(t, [spot("EUR", "USD", "1.0810000000")]);
  assert.equal(fix.status, "APPLIED");
  const now = await ask(t, "EUR", "USD");
  assert.deepEqual([now?.rate, now?.loadIds], ["1.0810000000", [fix.loadId]]);
  assert.equal((await events(t)).length, 2);
  const rows = await q(db).selectFrom("rates").select("rate_id").where("tenant_id", "=", t).execute();
  assert.equal(rows.length, 2, "the first load is kept");
});

dbTest("a load by a person is told to Audit; a feed's routine load is not", async () => {
  const t = newTenant();
  await send(t, [spot("EUR", "USD", "1.08")]); // by "test": a feed
  await fx.commands.loadRates({ tenantId: t, source: "manual", businessDate: D1, rows: [spot("GBP", "USD", "1.27")], by: "user:alice" });
  const told = (await fx.outbox.pending(1000)).flatMap((e) => (e.tenantId === t && e.type === "fx-rate.change-recorded" ? [[e.action, e.actor, e.programId, e.fields]] : []));
  assert.deepEqual(told, [["fx-rates.loaded", "user:alice", null, []]]);
});

dbTest("an invalid load writes nothing", async () => {
  const t = newTenant();
  await assert.rejects(send(t, [spot("EUR", "USD", "1.08"), spot("GBP", "GBP", "1")]), RatesInvalid);
  await assert.rejects(send(t, [spot("EUR", "USD", "1.08")], asOfDate("2026-03-11")), /in the future/);
  await assert.rejects(send(t, [spot("EUR", "USD", "1.08")], D1, "bad source!"), RatesInvalid);
  assert.equal(await ask(t, "EUR", "USD"), null);
  assert.deepEqual(await events(t), []);
  assert.equal((await q(db).selectFrom("rate_loads").select("load_id").where("tenant_id", "=", t).execute()).length, 0);
});

dbTest("events carry identifiers only", async () => {
  const t = newTenant();
  const r = await send(t, [spot("EUR", "USD", "1.08")]);
  const [e] = await events(t);
  assert.deepEqual(Object.keys(e!).sort(), ["businessDate", "eventId", "loadId", "occurredAt", "source", "tenantId", "type"]);
  assert.equal(e!.loadId, r.loadId);
  await fx.outbox.markPublished([e!.eventId]);
  assert.deepEqual(await events(t), []);
});

dbTest("stale and outlier rates are kept but flagged; a valid one wins; a derived rate shows its weakest part", async () => {
  const t = newTenant();
  await fx.commands.setStaleAfter(t, "vendor", 120);
  await send(t, [spot("EUR", "USD", "1.1000000000")], D1, "vendor");
  // an observation five hours before the end of the next date is stale for this source
  const old = await send(t, [spot("EUR", "USD", "1.1000000000", { observedAt: "2026-03-06T19:00:00Z" })], D2, "vendor");
  assert.equal(old.flagged, 1);
  const stale = await ask(t, "EUR", "USD", { asOf: D2 });
  assert.deepEqual([stale?.rate, stale?.quality], ["1.1000000000", "STALE"]);

  const out = await send(t, [spot("EUR", "USD", "1.3000000000", { observedAt: "2026-03-07T20:00:00Z" })], asOfDate("2026-03-07"), "bank");
  assert.equal(out.flagged, 0, "bank has no earlier valid rate to compare with");
  await send(t, [spot("EUR", "USD", "1.1000000000")], asOfDate("2026-03-07"), "bank"); // other content, same date: becomes the latest
  await send(t, [spot("USD", "JPY", "150")], asOfDate("2026-03-08"), "bank");
  const jump = await send(t, [spot("USD", "JPY", "170", { observedAt: "2026-03-09T20:00:00Z" })], asOfDate("2026-03-09"), "bank");
  assert.equal(jump.flagged, 1, "13% from the prior valid rate");
  const flagged = await ask(t, "USD", "JPY", { asOf: asOfDate("2026-03-09") });
  assert.deepEqual([flagged?.rate, flagged?.quality], ["170.0000000000", "OUTLIER"]);
  await send(t, [spot("EUR", "USD", "1.1", { observedAt: "2026-03-09T20:00:00Z" })], asOfDate("2026-03-09"), "bank");
  const crossed = await ask(t, "EUR", "JPY", { asOf: asOfDate("2026-03-09") });
  assert.deepEqual([crossed?.derivation, crossed?.quality], ["CROSS", "OUTLIER"]);

  // two loads for one date: a later flagged load does not hide an earlier valid one
  const t2 = newTenant();
  await send(t2, [spot("EUR", "USD", "1.1")], D1, "bank");
  await send(t2, [spot("EUR", "USD", "1.1")], D2, "bank");
  await send(t2, [spot("EUR", "USD", "1.5", { observedAt: "2026-03-07T20:00:00Z" })], asOfDate("2026-03-07"), "bank");
  await send(t2, [spot("EUR", "USD", "1.1", { observedAt: "2026-03-07T21:00:00Z" })], asOfDate("2026-03-07"), "bank");
  assert.deepEqual((await ask(t2, "EUR", "USD", { asOf: asOfDate("2026-03-07") }))?.quality, "VALID");
});

dbTest("preferred source, explicit source and the outlier setting", async () => {
  const t = newTenant();
  await send(t, [spot("EUR", "USD", "1.1000000000")], D1, "vendor");
  await send(t, [spot("EUR", "USD", "1.1100000000")], D1, "bank");
  assert.equal((await ask(t, "EUR", "USD"))?.source, "bank", "no preference: the latest load");
  await fx.commands.setPreferredSource(t, "vendor");
  assert.deepEqual([(await ask(t, "EUR", "USD"))?.rate, (await ask(t, "EUR", "USD", { source: "bank" }))?.rate], ["1.1000000000", "1.1100000000"]);
  await fx.commands.setPreferredSource(t, "nobody");
  assert.equal(await ask(t, "EUR", "USD"), null, "the preferred source has no rate");
  await fx.commands.setPreferredSource(t, null);
  assert.equal((await ask(t, "EUR", "USD"))?.source, "bank");

  await fx.commands.setOutlierShare(t, 0.01);
  await send(t, [spot("GBP", "USD", "1.2000000000")], D1, "bank");
  const r = await send(t, [spot("GBP", "USD", "1.2300000000")], D2, "bank");
  assert.equal(r.flagged, 1, "2.5% is above the 1% setting");
  await assert.rejects(fx.commands.setOutlierShare(t, 0), RangeError);
  await assert.rejects(fx.commands.setStaleAfter(t, "bank", 0), RangeError);
});

dbTest("tenant isolation", async () => {
  const a = newTenant();
  const b = newTenant();
  await send(a, [spot("EUR", "USD", "1.1000000000")]);
  await send(b, [spot("EUR", "USD", "1.2000000000")]);
  assert.equal((await ask(a, "EUR", "USD"))?.rate, "1.1000000000");
  assert.equal((await ask(b, "EUR", "USD"))?.rate, "1.2000000000");
  assert.equal(await ask(newTenant(), "EUR", "USD"), null);
});

dbTest("the database refuses a spot with a tenor and a rate that is not positive", async () => {
  const t = newTenant();
  const r = await send(t, [spot("EUR", "USD", "1.1")]);
  const base = {
    tenant_id: t, load_id: r.loadId, source_code: "bank", business_date: D1, base_currency: "GBP", quote_currency: "USD", rate_type: "SPOT" as const,
    tenor: "SPOT", value_date: null, all_in_rate: "1", spot_rate: null, forward_points: null, bid: null, mid: null, ask: null, observed_at: new Date(), quality: "VALID" as const,
  };
  await assert.rejects(q(db).insertInto("rates").values({ ...base, rate_id: randomUUID(), tenor: "1M" }).execute(), /check/i);
  await assert.rejects(q(db).insertInto("rates").values({ ...base, rate_id: randomUUID(), all_in_rate: "0" }).execute(), /check/i);
  await assert.rejects(q(db).insertInto("rates").values({ ...base, rate_id: randomUUID(), base_currency: "EUR", quote_currency: "USD" }).execute(), /unique|duplicate/i);
});

dbTest("the same load arriving at the same moment is applied once", async () => {
  const t = newTenant();
  const results = await Promise.all([1, 2, 3].map(() => send(t, [spot("EUR", "USD", "1.1000000000")])));
  assert.deepEqual(results.map((r) => r.status).sort(), ["APPLIED", "DUPLICATE", "DUPLICATE"]);
  assert.equal((await events(t)).length, 1);
});
