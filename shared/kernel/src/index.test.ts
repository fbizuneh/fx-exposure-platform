import { test } from "node:test";
import assert from "node:assert/strict";
import { accountId, asOfDate, cycleId, entityId, lineageRef, programId, tenantId } from "./index.ts";

const UUID = "3f2b8c1e-5d4a-4c7e-9b1a-0e6f2a7d8c90";

test("tenant and cycle ids must be UUIDs and are lower-cased", () => {
  assert.equal(tenantId(UUID.toUpperCase()), UUID);
  assert.equal(cycleId(UUID), UUID);
  assert.throws(() => tenantId("acme"), TypeError);
  assert.throws(() => cycleId(""), TypeError);
});

test("program, entity and account ids are opaque non-empty strings", () => {
  assert.equal(programId("DAILY"), "DAILY");
  assert.equal(entityId("E-100"), "E-100");
  assert.equal(accountId("1200"), "1200");
  assert.throws(() => programId(" "), TypeError);
  assert.throws(() => entityId(" E-1"), TypeError);
});

test("as-of date must be a real calendar date", () => {
  assert.equal(asOfDate("2026-02-28"), "2026-02-28");
  assert.equal(asOfDate("2028-02-29"), "2028-02-29");
  assert.throws(() => asOfDate("2026-02-30"), TypeError);
  assert.throws(() => asOfDate("2026-2-3"), TypeError);
  assert.throws(() => asOfDate("2026-02-28T00:00:00Z"), TypeError);
});

test("lineage reference needs source system, batch and record", () => {
  assert.deepEqual(lineageRef("SAP", "b1", "r9"), { sourceSystem: "SAP", batchId: "b1", recordId: "r9" });
  assert.throws(() => lineageRef("SAP", "", "r9"), TypeError);
});
