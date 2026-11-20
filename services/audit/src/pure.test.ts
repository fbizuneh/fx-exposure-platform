import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, hashOf, type Hashed } from "./chain.ts";

const base: Hashed = { tenantId: "t", seq: 1, recordId: "r", source: "exposure-management", programId: "BS", actor: "user:u", action: "cycle.approved", targetType: "cycle", targetId: "c1", fields: [], occurredAt: "2026-03-10T12:00:00.000Z", recordedAt: "2026-03-10T12:00:05.000Z" };

test("a hash is stable and changes when the previous hash or any part of the record changes", () => {
  const h = hashOf(GENESIS, base);
  assert.equal(h, hashOf(GENESIS, { ...base }));
  assert.match(h, /^[0-9a-f]{64}$/);
  const variants: Partial<Hashed>[] = [
    { tenantId: "u" }, { seq: 2 }, { recordId: "s" }, { source: "fx-trade" }, { programId: null }, { actor: "user:v" }, { action: "cycle.skipped" },
    { targetType: "program" }, { targetId: "c2" }, { fields: ["reason"] }, { occurredAt: "2026-03-10T12:00:00.001Z" }, { recordedAt: "2026-03-10T12:00:05.001Z" },
  ];
  for (const v of variants) assert.notEqual(hashOf(GENESIS, { ...base, ...v }), h, JSON.stringify(v));
  assert.notEqual(hashOf("other", base), h);
});

test("moving a value between neighbouring parts cannot give the same hash", () => {
  assert.notEqual(hashOf(GENESIS, { ...base, action: "a", targetType: "bc" }), hashOf(GENESIS, { ...base, action: "ab", targetType: "c" }));
});
