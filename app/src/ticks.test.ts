import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./log.ts";
import { createLoop, newStats, todayIn } from "./ticks.ts";

const quiet = createLogger("error", () => {});
const lines = () => {
  const out: string[] = [];
  return { out, log: createLogger("debug", (l) => out.push(l)) };
};

test("today's date follows the time zone", () => {
  const t = new Date("2026-11-20T02:00:00Z");
  assert.equal(todayIn("UTC", t), "2026-11-20");
  assert.equal(todayIn("America/Phoenix", t), "2026-11-19");
  assert.equal(todayIn("Pacific/Auckland", t), "2026-11-20");
});

test("a pass that starts while the last one is running is skipped and counted", async () => {
  const stats = newStats();
  let release!: () => void;
  let runs = 0;
  const loop = createLoop("t", 1, () => { runs++; return new Promise<void>((r) => { release = r; }); }, quiet, stats);
  const first = loop.runOnce();
  const second = loop.runOnce();
  assert.equal(runs, 1);
  assert.equal(stats.skipped, 1);
  release();
  await Promise.all([first, second]);
  const third = loop.runOnce();
  assert.equal(runs, 2, "once the first is over a new pass runs");
  release();
  await third;
});

test("a pass that throws is logged and the next one still runs", async () => {
  const { out, log } = lines();
  let runs = 0;
  const loop = createLoop("t", 1, async () => { runs++; if (runs === 1) throw new Error("first fails"); }, log, newStats());
  await loop.runOnce();
  await loop.runOnce();
  assert.equal(runs, 2);
  const failure = out.map((l) => JSON.parse(l)).find((l) => l.msg === "tick failed");
  assert.equal(failure.loop, "t");
  assert.equal(failure.error.message, "first fails");
});

test("stop waits for a running pass, but only up to the limit", async () => {
  const done: string[] = [];
  const quick = createLoop("q", 1, async () => { await new Promise((r) => setTimeout(r, 50)); done.push("quick finished"); }, quiet, newStats());
  void quick.runOnce();
  await quick.stop(2000);
  assert.deepEqual(done, ["quick finished"], "stop returned after the pass finished");

  const slow = createLoop("s", 1, () => new Promise(() => {}), quiet, newStats());
  void slow.runOnce();
  const began = Date.now();
  await slow.stop(100);
  assert.ok(Date.now() - began < 1500, "stop gave up waiting for a pass that never ends");
});
