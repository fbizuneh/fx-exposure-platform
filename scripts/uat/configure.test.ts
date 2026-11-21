import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrate } from "../migrate.mjs";
import { composeApp, type App } from "../../app/src/compose.ts";
import { startDueCycles } from "../../app/src/dispatch.ts";
import { policyProblems } from "../../services/hedge-recommendation/src/policy.ts";
import { configure, type UatConfig } from "./configure.ts";
import { reset, uatDatabaseName } from "./reset.ts";

const config = JSON.parse(await readFile(new URL("../../packs/uat/config.json", import.meta.url), "utf8")) as UatConfig;
test("the UAT sample policies satisfy the real policy validation", () => {
  assert.deepEqual(config.programs.map((p) => policyProblems(p.policy)), [[], []]);
});
test("reset rejects every database outside _uat and _test", () => {
  assert.equal(uatDatabaseName("postgres://localhost/fx_test"), "fx_test");
  assert.equal(uatDatabaseName("postgres://localhost/fx_uat"), "fx_uat");
  assert.throws(() => uatDatabaseName("postgres://localhost/fx_prod"), /_uat or _test/);
  assert.throws(() => uatDatabaseName("postgres://localhost/fx_uat_backup"), /_uat or _test/);
  assert.throws(() => uatDatabaseName("https://localhost/fx_test"), /valid PostgreSQL URL/);
});

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("UAT configuration database test SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
let app: App;
before(async () => {
  if (!enabled) return;
  await reset(url!);
  await migrate(url!);
  app = composeApp(url!);
});
after(async () => { if (enabled) await app.close(); });
test("configure refuses a second run and leaves programs able to start cycles", { skip: !enabled }, async () => {
  const tenant = await configure(app, config);
  await assert.rejects(configure(app, config), /already exists/);
  assert.equal((await app.exposureManagement.questions.tenantSettings(tenant)).segregationOfDuties, true);
  assert.deepEqual((await app.exposureManagement.questions.programCatalog(tenant)).map((p) => p.programId).sort(), ["BS-ENT", "BS-REG"]);
  const platformUserId = await app.identity.commands.ensurePlatformUser(config.platformUser);
  const started = await startDueCycles(app, tenant, "2026-11-20", { kind: "platform", platformUserId });
  assert.equal(started.length, 2);
});
