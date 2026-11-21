import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTotals } from "./control-totals.ts";
import { firstSharedDate, matchProgram, scopesMeet, type MatchFact } from "./match.ts";
import { checkRow, normalizeAmount, recordKey } from "./validate.ts";
import type { GlBalanceRow, MappingRule } from "./rows.ts";

const rule = (id: string, programId: string, kind: "INCLUDE" | "EXCLUDE", target: MappingRule["target"], over: Partial<MappingRule> = {}): MappingRule => ({
  ruleId: id, programId, kind, target, validFrom: "2026-01-01", validTo: null, sourceSystem: null, entityCode: null, dimensions: null, ...over,
});
const node = (nodeCode: string) => ({ type: "NODE" as const, chartCode: "C", nodeCode });
const acct = (accountNumber: string) => ({ type: "ACCOUNT" as const, chartCode: "C", accountNumber });
const fact = (over: Partial<MatchFact> = {}): MatchFact => ({
  chartCode: "C", accountNumber: "1000", hierarchyPath: ["111", "11", "1"], entityCode: "US1", sourceSystem: "erp", dimensions: {}, asOf: "2026-03-01", ...over,
});

test("a node rule covers everything below it; an exclude removes accounts from the same program", () => {
  assert.equal(matchProgram([rule("r1", "BS", "INCLUDE", node("1"))], fact()).programId, "BS");
  assert.equal(matchProgram([rule("r1", "BS", "INCLUDE", node("2"))], fact()).outcome, "UNMATCHED");
  const withExclude = [rule("r1", "BS", "INCLUDE", node("1")), rule("r2", "BS", "EXCLUDE", acct("1000"))];
  const m = matchProgram(withExclude, fact());
  assert.deepEqual([m.outcome, m.programId, m.matchedRuleIds], ["EXCLUDED", null, ["r2"]]);
  assert.equal(matchProgram(withExclude, fact({ accountNumber: "1100" })).outcome, "ASSIGNED");
  assert.equal(matchProgram([rule("r2", "BS", "EXCLUDE", acct("1000"))], fact()).outcome, "UNMATCHED", "an exclude with nothing to remove does nothing");
});

test("another program can take what a program excludes; two programs claiming is a conflict", () => {
  const rules = [rule("a", "BS", "INCLUDE", node("1")), rule("b", "BS", "EXCLUDE", acct("1000")), rule("c", "CF", "INCLUDE", acct("1000"))];
  assert.deepEqual([matchProgram(rules, fact()).outcome, matchProgram(rules, fact()).programId], ["ASSIGNED", "CF"]);
  const clash = matchProgram([rule("a", "BS", "INCLUDE", node("1")), rule("c", "CF", "INCLUDE", acct("1000"))], fact());
  assert.deepEqual([clash.outcome, clash.claimingPrograms], ["MULTI_MATCH", ["BS", "CF"]]);
});

test("scope: dates are end-exclusive; source system, entity and dimensions narrow a rule", () => {
  const base = rule("r", "BS", "INCLUDE", node("1"));
  assert.equal(matchProgram([{ ...base, validTo: "2026-03-01" }], fact({ asOf: "2026-03-01" })).outcome, "UNMATCHED");
  assert.equal(matchProgram([{ ...base, validTo: "2026-03-01" }], fact({ asOf: "2026-02-28" })).outcome, "ASSIGNED");
  assert.equal(matchProgram([{ ...base, validFrom: "2026-03-02" }], fact()).outcome, "UNMATCHED");
  assert.equal(matchProgram([{ ...base, sourceSystem: "tms" }], fact()).outcome, "UNMATCHED");
  assert.equal(matchProgram([{ ...base, sourceSystem: "erp", entityCode: "US1" }], fact()).outcome, "ASSIGNED");
  assert.equal(matchProgram([{ ...base, entityCode: "DE1" }], fact()).outcome, "UNMATCHED");
  const dims = { ...base, dimensions: { costCenter: ["A", "B"] } };
  assert.equal(matchProgram([dims], fact({ dimensions: { costCenter: "B" } })).outcome, "ASSIGNED");
  assert.equal(matchProgram([dims], fact({ dimensions: { costCenter: "C" } })).outcome, "UNMATCHED");
  assert.equal(matchProgram([dims], fact()).outcome, "UNMATCHED", "a dimension the balance lacks does not match");
  assert.equal(matchProgram([{ ...base, target: { type: "NODE", chartCode: "OTHER", nodeCode: "1" } }], fact()).outcome, "UNMATCHED", "another chart");
});

test("a TMS-only rule beside an ERP rule: the source system decides", () => {
  const rules = [
    rule("erp", "BS", "INCLUDE", acct("1000"), { sourceSystem: "erp" }),
    rule("tms", "CF", "INCLUDE", acct("1000"), { sourceSystem: "tms" }),
  ];
  assert.equal(matchProgram(rules, fact({ sourceSystem: "erp" })).programId, "BS");
  assert.equal(matchProgram(rules, fact({ sourceSystem: "tms" })).programId, "CF");
});

test("scopes and dates that cannot meet are not an overlap", () => {
  const a = rule("a", "BS", "INCLUDE", node("1"), { sourceSystem: "erp" });
  assert.equal(scopesMeet(a, rule("b", "CF", "INCLUDE", node("1"), { sourceSystem: "tms" })), false);
  assert.equal(scopesMeet(a, rule("b", "CF", "INCLUDE", node("1"))), true);
  assert.equal(scopesMeet(rule("a", "BS", "INCLUDE", node("1"), { entityCode: "US1" }), rule("b", "CF", "INCLUDE", node("1"), { entityCode: "DE1" })), false);
  assert.equal(scopesMeet(rule("a", "BS", "INCLUDE", node("1"), { dimensions: { cc: ["A"] } }), rule("b", "CF", "INCLUDE", node("1"), { dimensions: { cc: ["B"] } })), false);
  assert.equal(firstSharedDate(rule("a", "BS", "INCLUDE", node("1"), { validTo: "2026-02-01" }), rule("b", "CF", "INCLUDE", node("1"), { validFrom: "2026-02-01" })), null);
  assert.equal(firstSharedDate(rule("a", "BS", "INCLUDE", node("1")), rule("b", "CF", "INCLUDE", node("1"), { validFrom: "2026-02-01" })), "2026-02-01");
});

const row = (over: Partial<GlBalanceRow> = {}): GlBalanceRow => ({ entityCode: "US1", accountNumber: "1000", currency: "USD", balance: "100.50", debit: null, credit: null, asOf: null, dimensions: {}, ...over });

test("amounts: signed balance as given, or debit minus credit; never both; at most 4 places", () => {
  assert.equal(normalizeAmount(row({ balance: "-12.5" })).amount, "-12.5000");
  assert.equal(normalizeAmount(row({ balance: null, debit: "100", credit: "30.25" })).amount, "69.7500");
  assert.equal(normalizeAmount(row({ balance: null, credit: "5" })).amount, "-5.0000");
  assert.equal(normalizeAmount(row({ balance: "1", debit: "1" })).issues[0]?.ruleCode, "GL_AMOUNT_CONFLICT");
  assert.equal(normalizeAmount(row({ balance: null })).issues[0]?.ruleCode, "GL_AMOUNT_MISSING");
  assert.equal(normalizeAmount(row({ balance: "1.23456" })).issues[0]?.ruleCode, "GL_AMOUNT_INVALID");
  assert.equal(normalizeAmount(row({ balance: "abc" })).issues[0]?.ruleCode, "GL_AMOUNT_INVALID");
  assert.equal(normalizeAmount(row({ balance: null, debit: "-1" })).issues[0]?.ruleCode, "GL_AMOUNT_INVALID", "debit and credit are not negative");
  assert.equal(normalizeAmount(row({ balance: "1.2300" })).amount, "1.2300", "trailing zeros are fine");
});

test("row checks name each problem", () => {
  assert.deepEqual(checkRow(row(), "2026-03-01").issues, []);
  const codes = (r: GlBalanceRow) => checkRow(r, "2026-03-01").issues.map((i) => i.ruleCode);
  assert.deepEqual(codes(row({ entityCode: null, accountNumber: " ", currency: null })), ["GL_ENTITY_MISSING", "GL_ACCOUNT_MISSING", "GL_CURRENCY_MISSING"]);
  assert.deepEqual(codes(row({ currency: "XYZ" })), ["GL_CURRENCY_UNSUPPORTED"]);
  assert.deepEqual(codes(row({ currency: "usd" })), ["GL_CURRENCY_UNSUPPORTED"]);
  assert.deepEqual(codes(row({ currency: "CNH" })), [], "offshore yuan is accepted on purpose (decision 0028)");
  assert.deepEqual(codes(row({ currency: "CNY" })), []);
  assert.deepEqual(codes(row({ asOf: "2026-02-28" })), ["GL_AS_OF_MISMATCH"]);
  assert.deepEqual(codes(row({ asOf: "2026-03-01" })), []);
});

test("a balance is identified by entity, account, currency and dimensions, whatever the column order", () => {
  assert.equal(recordKey(row({ dimensions: { b: "2", a: "1" } })), recordKey(row({ dimensions: { a: "1", b: "2" } })));
  assert.notEqual(recordKey(row()), recordKey(row({ currency: "EUR" })));
  assert.notEqual(recordKey(row()), recordKey(row({ dimensions: { costCenter: "A" } })));
  assert.equal(recordKey(row()), "US1|1000|USD|");
});

test("control totals: matching totals have no differences", () => {
  const received = new Map([["USD", { rows: 2, sum: "140.5000" }]]);
  assert.deepEqual(diffTotals(received, [{ currency: "USD", rowCount: 2, sum: "140.50" }]), [], "the same amount, written with a different scale, still matches");
});

test("control totals: a different sum, a different row count, and a currency missing on either side each produce a difference", () => {
  const received = new Map([["USD", { rows: 2, sum: "140.5000" }]]);
  assert.equal(diffTotals(received, [{ currency: "USD", rowCount: 2, sum: "999.00" }]).length, 1, "sum differs");
  assert.equal(diffTotals(received, [{ currency: "USD", rowCount: 5, sum: "140.50" }]).length, 1, "row count differs");
  assert.match(diffTotals(received, [{ currency: "USD", rowCount: 2, sum: "140.50" }, { currency: "GBP", rowCount: 1, sum: "1.00" }])[0]!, /GBP: received 0 rows/, "expected a currency that was not received");
  assert.match(diffTotals(received, [])[0]!, /USD: received 2 rows.*not expected/, "received a currency that was not expected");
  assert.match(diffTotals(new Map(), [{ currency: "", rowCount: 1, sum: "3.00" }])[0]!, /\(no currency\)/, "the no-currency bucket is named, not the empty string, in a message");
});
