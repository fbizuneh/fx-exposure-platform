import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_END_SHARE, plan, shouldHold, stable, type OpenRow } from "./diff.ts";
import { ancestors, descendants, findCycle } from "./tree.ts";
import { ChangeSetInvalid, validateAccounts, validateEntities, validateHierarchy } from "./validate.ts";
import { chartKey, type AccountRow, type EntityRow, type HierarchyNodeRow } from "./rows.ts";

const entity = (code: string, over: Partial<EntityRow> = {}): EntityRow => ({
  code, name: code, type: "BUSINESS_UNIT", parentCode: null, countryCode: null, functionalCurrency: null,
  isLegalEntity: false, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over,
});

test("stable JSON ignores key order", () => {
  assert.equal(stable({ b: 1, a: [2, { d: 1, c: 2 }] }), stable({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(stable({ a: null }), stable({ a: "null" }));
});

test("trees: cycles, descendants and ancestors", () => {
  assert.equal(findCycle(new Map([["a", "b"], ["b", "a"]])) !== null, true);
  assert.equal(findCycle(new Map([["a", null], ["b", "a"], ["c", "b"]])), null);
  const items = [{ id: "g", p: null }, { id: "r", p: "g" }, { id: "e1", p: "r" }, { id: "e2", p: "r" }, { id: "x", p: null }];
  const idOf = (t: { id: string }) => t.id;
  const parentOf = (t: { p: string | null }) => t.p;
  assert.deepEqual(descendants(items, idOf, parentOf, "g").map(idOf), ["r", "e1", "e2"]);
  assert.deepEqual(ancestors(items, idOf, parentOf, "e1").map(idOf), ["r", "g"]);
  assert.deepEqual(descendants(items, idOf, parentOf, "x"), []);
});

test("entities: legal entity needs a currency; codes, parents and cycles are checked", () => {
  const none = new Map<string, string | null>();
  assert.deepEqual(validateEntities([entity("A"), entity("B", { parentCode: "A" })], none, "SNAPSHOT"), []);
  assert.match(validateEntities([entity("A", { isLegalEntity: true })], none, "SNAPSHOT").join(), /functional currency/);
  assert.match(validateEntities([entity("A", { type: "LEGAL_ENTITY" })], none, "SNAPSHOT").join(), /functional currency/);
  assert.match(validateEntities([entity("A"), entity("A")], none, "SNAPSHOT").join(), /appears twice/);
  assert.match(validateEntities([entity("B", { parentCode: "A" })], none, "SNAPSHOT").join(), /unknown parent/);
  assert.deepEqual(validateEntities([entity("B", { parentCode: "A" })], new Map([["A", null]]), "PARTIAL"), []);
  assert.match(validateEntities([entity("A", { parentCode: "B" }), entity("B", { parentCode: "A" })], none, "SNAPSHOT").join(), /cycle/);
  assert.match(validateEntities([entity("A", { functionalCurrency: "usd" })], none, "SNAPSHOT").join(), /three capital letters/);
  assert.match(validateEntities([entity(" A")], none, "SNAPSHOT").join(), /required/);
});

test("hierarchy: parents stay inside their chart", () => {
  const node = (chartCode: string, code: string, parentCode: string | null): HierarchyNodeRow => ({ chartCode, code, name: code, classification: "ASSETS", parentCode });
  const none = new Map<string, string | null>();
  assert.deepEqual(validateHierarchy([node("C", "1", null), node("C", "11", "1")], none, "SNAPSHOT"), []);
  assert.match(validateHierarchy([node("C", "11", "1"), node("D", "1", null)], none, "SNAPSHOT").join(), /unknown parent/);
});

test("accounts: must attach to a known hierarchy node", () => {
  const acct = (hierarchyNodeCode: string | null): AccountRow => ({
    chartCode: "C", accountNumber: "1000", name: "Cash", statementType: "BALANCE_SHEET", normalBalance: "DEBIT",
    monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode,
  });
  const known = new Set([chartKey("C", "1")]);
  assert.deepEqual(validateAccounts([acct("1")], known), []);
  assert.deepEqual(validateAccounts([acct(null)], known), []);
  assert.match(validateAccounts([acct("9")], known).join(), /does not exist/);
  assert.ok(new ChangeSetInvalid(["x"]).message.includes("x"));
});

test("plan: creates, changes, ends and repeats; partial never ends", () => {
  const open = new Map<string, OpenRow>([
    ["a", { id: "1", validFrom: "2026-01-01", source: "erp", attrs: "A1" }],
    ["b", { id: "2", validFrom: "2026-01-01", source: "erp", attrs: "B1" }],
    ["m", { id: "3", validFrom: "2026-01-01", source: "manual", attrs: "M1" }],
  ]);
  const incoming = new Map([["a", "A2"], ["c", "C1"]]);
  assert.deepEqual(plan(open, incoming, "SNAPSHOT", "erp"), { creates: ["c"], changes: ["a"], ends: ["b"], unchanged: 0 });
  assert.deepEqual(plan(open, incoming, "PARTIAL", "erp"), { creates: ["c"], changes: ["a"], ends: [], unchanged: 0 });
  assert.deepEqual(plan(open, new Map([["a", "A1"], ["b", "B1"]]), "SNAPSHOT", "erp").ends, []);
});

test("safeguard: holds only a large share of a large set", () => {
  assert.equal(shouldHold(100, 21, DEFAULT_MAX_END_SHARE), true);
  assert.equal(shouldHold(100, 20, DEFAULT_MAX_END_SHARE), false);
  assert.equal(shouldHold(9, 5, DEFAULT_MAX_END_SHARE), false, "too few rows for the share to mean anything");
  assert.equal(shouldHold(100, 0, DEFAULT_MAX_END_SHARE), false);
  assert.equal(shouldHold(10, 3, 0.2), true);
});
