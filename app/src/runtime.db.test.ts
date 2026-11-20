// The runtime against a real database: start-up, health routes, the two loops, shutdown. Needs TEST_DATABASE_URL (name ends in _test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { programId, type TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http.ts";
import { createLogger } from "./log.ts";
import { checkReady, expectedMigrations } from "./ready.ts";
import { startRuntime, ShutdownTimedOut, type Runtime } from "./runtime.ts";
import net from "node:net";
import { cycleTick, deliveryTick, newStats } from "./ticks.ts";
import { deliveryProblems } from "./dispatch.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("runtime database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

const SCHEMAS = ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"];
const lines: string[] = [];
const log = createLogger("debug", (l) => lines.push(l));
const clock = { now: new Date("2026-11-10T23:00:00Z") };
let runtime: Runtime;

const get = async (p: string) => {
  const r = await fetch(`http://127.0.0.1:${runtime.port}${p}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

before(async () => {
  if (!enabled) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const s of SCHEMAS) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  await client.end();
  // A fresh database: the runtime must migrate it itself.
  runtime = await startRuntime(loadConfig({ DATABASE_URL: url, PORT: "0", TIMER_ENABLED: "false" }), log, { now: () => clock.now });
});
after(async () => {
  if (enabled) await runtime.shutdown(1000);
});

async function tenantWithDailyProgram(name: string): Promise<{ tenant: TenantId; admin: Actor }> {
  const { app } = runtime;
  const tenant = await app.identity.commands.createTenant(name);
  const ops = (await app.identity.commands.createPlatformUser({ issuer: "platform", externalSubject: randomUUID() })) as string;
  await app.identity.commands.enableProgram(tenant, programId("BS"), ops);
  const adminId = await app.identity.commands.addUser(tenant, { issuer: "idp", externalSubject: randomUUID(), roles: ["TREASURY_ADMIN"] }, ops);
  const admin: Actor = { kind: "user", userId: adminId };
  await app.exposureManagement.commands.defineProgram({
    tenantId: tenant, programId: "BS", name: "Daily balance sheet", type: "BALANCE_SHEET", effectiveFrom: "2026-01-01", actor: admin,
    settings: { nettingLevel: "ENTITY", bucketScheme: { kind: "MONTHS" }, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } },
  });
  return { tenant, admin };
}

dbTest("start-up migrates an empty database: every service schema and every migration file is present", async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const [schema, files] of Object.entries(expectedMigrations())) {
      const done = (await client.query(`SELECT filename FROM ${schema}.schema_migrations ORDER BY filename`)).rows.map((r) => r.filename);
      assert.deepEqual(done, files, `${schema} has every migration`);
    }
  } finally {
    await client.end();
  }
  assert.ok(lines.some((l) => JSON.parse(l).msg === "started"), "one started line is logged");
  assert.ok(Object.keys(expectedMigrations()).length >= 9);
});

dbTest("the health routes answer: healthz and readyz are 200, status carries counts only, anything else is a JSON 404", async () => {
  assert.deepEqual(await get("/healthz"), { status: 200, body: { status: "ok" } });
  assert.deepEqual(await get("/readyz"), { status: 200, body: { status: "ready" } });
  const s = await get("/status");
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.events, { waitingToRetry: 0, stuck: 0 });
  assert.equal(s.body.skippedTicks, 0);
  assert.equal(typeof s.body.uptimeSeconds, "number");
  assert.equal(JSON.stringify(s.body).includes("tenant"), false, "no tenant names or ids in /status");
  assert.deepEqual(await get("/nope"), { status: 404, body: { error: "not found" } });
});

dbTest("readyz is 503 with a reason when the database cannot be reached or a migration is missing", async () => {
  const down = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
  const r1 = await checkReady(down);
  await down.end();
  assert.equal(r1.ready, false);
  assert.match((r1 as { reason: string }).reason, /database not reachable/);

  // A root with one migration file the database has never seen.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ready-"));
  fs.mkdirSync(path.join(root, "services", "identity", "migrations"), { recursive: true });
  fs.writeFileSync(path.join(root, "services", "identity", "migrations", "9999_not_applied.sql"), "SELECT 1;");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const r2 = await checkReady(pool, root);
  await pool.end();
  assert.deepEqual(r2, { ready: false, reason: "identity has 1 migration(s) not applied, the first is 9999_not_applied.sql" });

  // And the route turns that into a 503.
  const server = createHttpServer({ app: runtime.app, stats: newStats(), startedAt: new Date(), version: "t", ready: async () => r2 });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { status: string }).status, "not ready");
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
});

dbTest("a delivery tick delivers what the services announced, and a second tick changes nothing", async () => {
  const { app, stats } = runtime;
  const { tenant } = await tenantWithDailyProgram("Delivery test");
  const before = await app.identity.outbox.pending(100, clock.now);
  assert.ok(before.some((e) => (e as { tenantId: string }).tenantId === tenant), "the program announcements are waiting");
  const delivered = await deliveryTick(app, log, stats, () => clock.now);
  assert.ok(delivered > 0);
  assert.equal((await app.identity.outbox.pending(100, clock.now)).length, 0);
  assert.equal(await deliveryTick(app, log, stats, () => clock.now), 0, "delivering again changes nothing");
  assert.equal(stats.lastDelivery?.delivered, 0);
  const s = await get("/status");
  assert.deepEqual((s.body.lastDelivery as { delivered: number }).delivered, 0);
});

dbTest("a cycle tick starts the due cycle for every active tenant, and one tenant failing does not stop the others", async () => {
  const { app } = runtime;
  const scheduler: Actor = { kind: "platform", platformUserId: await app.identity.commands.ensurePlatformUser({ issuer: "platform", externalSubject: "scheduler" }) };
  const a = await tenantWithDailyProgram("Cycles A");
  const b = await tenantWithDailyProgram("Cycles B");
  const c = await tenantWithDailyProgram("Cycles C");
  await deliveryTick(app, log, newStats(), () => clock.now);

  // The first of the three fails when asked what is due.
  const failing = {
    ...app,
    exposureManagement: {
      ...app.exposureManagement,
      questions: {
        ...app.exposureManagement.questions,
        dueCycles: (t: TenantId, today: never) => (t === a.tenant ? Promise.reject(new Error("a's schedule is broken")) : app.exposureManagement.questions.dueCycles(t, today)),
      },
    },
  } as typeof app;
  lines.length = 0;
  const stats = newStats();
  const started = await cycleTick(failing, log, stats, "UTC", scheduler, () => clock.now);
  assert.ok(started >= 2, "B and C each started a cycle");
  const logged = lines.map((l) => JSON.parse(l));
  assert.ok(logged.some((l) => l.msg === "cycle check failed for a tenant" && l.tenantId === a.tenant && l.error.message === "a's schedule is broken"));
  const startedFor = logged.filter((l) => l.msg === "cycle started").map((l) => l.tenantId);
  assert.ok(startedFor.includes(b.tenant) && startedFor.includes(c.tenant));
  assert.ok(!startedFor.includes(a.tenant));
  assert.equal(stats.lastCycleCheck?.started, started);

  // Run for real: A's cycle starts now, and an open cycle holds the next one back, so B and C start nothing more.
  assert.equal(await cycleTick(app, log, newStats(), "UTC", scheduler, () => clock.now), 1);
});

dbTest("the cycle tick asks for the schedule on today's date in the platform time zone", async () => {
  const { app } = runtime;
  const scheduler: Actor = { kind: "platform", platformUserId: await app.identity.commands.ensurePlatformUser({ issuer: "platform", externalSubject: "scheduler" }) };
  const { tenant } = await tenantWithDailyProgram("Zone test");
  await deliveryTick(app, log, newStats(), () => clock.now);
  const asked: string[] = [];
  const spy = {
    ...app,
    exposureManagement: { ...app.exposureManagement, questions: { ...app.exposureManagement.questions, dueCycles: (t: TenantId, today: never) => { if (t === tenant) asked.push(today as string); return app.exposureManagement.questions.dueCycles(t, today); } } },
  } as typeof app;
  await cycleTick(spy, createLogger("error", () => {}), newStats(), "Pacific/Auckland", scheduler, () => clock.now); // 23:00 UTC on 10 Nov is already 11 Nov there
  await cycleTick(spy, createLogger("error", () => {}), newStats(), "America/Phoenix", scheduler, () => clock.now); // and 16:00 on 10 Nov in Phoenix
  assert.deepEqual(asked, ["2026-11-11", "2026-11-10"]);
});

dbTest("shutdown stops accepting requests and closes the database connections", async () => {
  const other = await startRuntime(loadConfig({ DATABASE_URL: url, PORT: "0", TIMER_ENABLED: "true", MIGRATE_ON_START: "false" }), createLogger("error", () => {}), { now: () => clock.now });
  const port = other.port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  await other.shutdown(1000);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  await other.shutdown(1000); // a second call is harmless
  assert.deepEqual((await deliveryProblems(runtime.app)).length, 0);
});

// Sends raw bytes so a request target that the URL parser rejects reaches the server exactly as a client could send it.
const rawRequest = (port: number, target: string) => new Promise<string>((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let data = "";
  socket.on("data", (c) => { data += c.toString(); });
  socket.on("end", () => resolve(data));
  socket.on("error", reject);
});

dbTest("a request target that cannot be parsed gets a generic 400 and the server keeps serving", async () => {
  const reply = await rawRequest(runtime.port, "//");
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.match(reply, /"error":"bad request"/);
  assert.equal((await get("/healthz")).status, 200); // the next request still works
  assert.equal((await get("/nothing-here")).status, 404); // a valid but unknown route is still 404
});

dbTest("shutdown has one deadline: a stalled database close is logged, rejected, and requests are already refused", async () => {
  const out: string[] = [];
  const other = await startRuntime(loadConfig({ DATABASE_URL: url, PORT: "0", TIMER_ENABLED: "false", MIGRATE_ON_START: "false" }), createLogger("error", (l) => out.push(l)), { now: () => clock.now });
  const port = other.port;
  const realClose = other.app.close.bind(other.app);
  (other.app as { close: () => Promise<void> }).close = () => new Promise<void>(() => {}); // a connection that never lets go
  const began = Date.now();
  await assert.rejects(other.shutdown(400), (e) => e instanceof ShutdownTimedOut && e.deadlineMs === 400);
  assert.ok(Date.now() - began < 3000);
  assert.ok(out.some((l) => l.includes("shutdown timed out")));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`)); // not accepting
  await realClose(); // release the real connections so the test run can end
});
