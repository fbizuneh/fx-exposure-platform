import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigInvalid, loadConfig } from "./config.ts";

const ok = { DATABASE_URL: "postgres://u@h/db" };
const problemsOf = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigInvalid) return e.problems;
    throw e;
  }
  return [];
};

test("defaults apply when only DATABASE_URL is given", () => {
  assert.deepEqual(loadConfig(ok), {
    databaseUrl: "postgres://u@h/db", port: 8080, migrateOnStart: true, timerEnabled: true, deliveryIntervalSeconds: 5,
    cycleCheckIntervalSeconds: 60, timezone: "UTC", logLevel: "info",
  });
});

test("every setting is read when given", () => {
  const c = loadConfig({ ...ok, PORT: "9000", MIGRATE_ON_START: "false", TIMER_ENABLED: "false", DELIVERY_INTERVAL_SECONDS: "2", CYCLE_CHECK_INTERVAL_SECONDS: "30", PLATFORM_TIMEZONE: "America/Phoenix", LOG_LEVEL: "debug" });
  assert.deepEqual([c.port, c.migrateOnStart, c.timerEnabled, c.deliveryIntervalSeconds, c.cycleCheckIntervalSeconds, c.timezone, c.logLevel], [9000, false, false, 2, 30, "America/Phoenix", "debug"]);
});

test("each setting that is missing or malformed is named in the error, and all are reported together", () => {
  assert.deepEqual(problemsOf({}), ["DATABASE_URL is required"]);
  assert.match(problemsOf({ DATABASE_URL: "mysql://x" })[0]!, /DATABASE_URL must start with/);
  assert.match(problemsOf({ ...ok, PORT: "abc" })[0]!, /PORT must be a whole number/);
  assert.match(problemsOf({ ...ok, PORT: "70000" })[0]!, /PORT must be a whole number/);
  assert.match(problemsOf({ ...ok, MIGRATE_ON_START: "yes" })[0]!, /MIGRATE_ON_START must be true or false/);
  assert.match(problemsOf({ ...ok, TIMER_ENABLED: "1" })[0]!, /TIMER_ENABLED must be true or false/);
  assert.match(problemsOf({ ...ok, DELIVERY_INTERVAL_SECONDS: "0" })[0]!, /DELIVERY_INTERVAL_SECONDS/);
  assert.match(problemsOf({ ...ok, CYCLE_CHECK_INTERVAL_SECONDS: "-5" })[0]!, /CYCLE_CHECK_INTERVAL_SECONDS/);
  assert.match(problemsOf({ ...ok, PLATFORM_TIMEZONE: "Mars/Base" })[0]!, /PLATFORM_TIMEZONE is not a known time zone/);
  assert.match(problemsOf({ ...ok, LOG_LEVEL: "loud" })[0]!, /LOG_LEVEL/);
  assert.equal(problemsOf({ PORT: "x", LOG_LEVEL: "loud" }).length, 3, "DATABASE_URL, PORT and LOG_LEVEL together");
});

test("an empty value counts as not set", () => {
  assert.equal(loadConfig({ ...ok, PORT: "  " }).port, 8080);
});
