import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./log.ts";

const fixed = () => new Date("2026-11-20T10:00:00Z");

test("a line is one JSON object with time, level, message and fields", () => {
  const lines: string[] = [];
  createLogger("info", (l) => lines.push(l), fixed).info("started", { port: 8080 });
  assert.deepEqual(JSON.parse(lines[0]!), { time: "2026-11-20T10:00:00.000Z", level: "info", msg: "started", port: 8080 });
});

test("secrets are redacted at any depth, and an error is written with its message and stack", () => {
  const lines: string[] = [];
  const log = createLogger("debug", (l) => lines.push(l), fixed);
  log.warn("x", { password: "p", nested: { Authorization: "Bearer abc", ok: 1 }, list: [{ token: "t" }] });
  const w = JSON.parse(lines[0]!);
  assert.equal(w.password, "[redacted]");
  assert.equal(w.nested.Authorization, "[redacted]");
  assert.equal(w.nested.ok, 1);
  assert.equal(w.list[0].token, "[redacted]");
  log.error("boom", { error: new Error("bad thing") });
  const e = JSON.parse(lines[1]!);
  assert.equal(e.error.message, "bad thing");
  assert.match(e.error.stack, /bad thing/);
});

test("lines below the level are not written", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (l) => lines.push(l), fixed);
  log.debug("a"); log.info("b"); log.warn("c"); log.error("d");
  assert.deepEqual(lines.map((l) => JSON.parse(l).msg), ["c", "d"]);
});
