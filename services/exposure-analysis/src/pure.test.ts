import { test } from "node:test";
import assert from "node:assert/strict";
import { asOfDate, entityId, accountId, lineageRef, programId } from "@shared/kernel";
import type { IncludedBalance } from "@services/data-source/contract";
import type { Account, Entity } from "@services/master-data/contract";
import { accountKey, buildBaseline, exposureCurrencyOf, filterBalances, netByLevel, orderPair, repairToPortfolio, requiredRates, round2 } from "./calc.ts";
import { Decimal } from "decimal.js";

const ent = (code: string, over: Partial<Entity> = {}): Entity => ({
  entityId: entityId(`id-${code}`), code, name: code, type: "LEGAL_ENTITY", parentEntityId: null, countryCode: null, functionalCurrency: "USD",
  isLegalEntity: true, isTreasuryEntity: false, isHedgeExecutionEntity: false, ...over,
});
const acct = (n: string, over: Partial<Account> = {}): Account => ({
  accountId: accountId(`a-${n}`), chartCode: "C", accountNumber: n, name: n, statementType: "BALANCE_SHEET", normalBalance: "DEBIT", monetaryFlag: true, fxRelevantFlag: true, hierarchyNodeCode: null, ...over,
});
let n = 0;
const bal = (entityCode: string, accountNumber: string, currency: string, amount: string): IncludedBalance => ({
  lineage: lineageRef("ERP", "b1", `r${++n}`), programId: programId("BS"), asOf: asOfDate("2026-11-09"), entityId: entityId(`id-${entityCode}`), entityCode, accountId: accountId(`a-${accountNumber}`),
  chartCode: "C", accountNumber, currency, amount, dimensions: {},
});
const entities = new Map([ent("US01"), ent("DE01", { functionalCurrency: "EUR" }), ent("UK01", { functionalCurrency: "GBP" }), ent("REG", { type: "REGION", isLegalEntity: false }), ent("NOFC", { functionalCurrency: null })].map((e) => [e.code, e]));
const accounts = new Map([acct("4000"), acct("9000", { monetaryFlag: false }), acct("9100", { fxRelevantFlag: false })].map((a) => [accountKey(a.chartCode, a.accountNumber), a]));
const RATES: Record<string, string> = { "EUR|USD": "1.1", "GBP|USD": "1.25", "EUR|GBP": "0.88", "USD|JPY": "150" };
const rateOf = (b: string, q: string): string => (b === q ? "1" : (RATES[`${b}|${q}`] ?? (RATES[`${q}|${b}`] ? new Decimal(1).div(RATES[`${q}|${b}`]!).toString() : (() => { throw new Error(`no rate ${b}-${q}`); })())));

test("pair order follows market convention, then alphabetical", () => {
  assert.deepEqual(orderPair("USD", "EUR"), ["EUR", "USD"]);
  assert.deepEqual(orderPair("JPY", "USD"), ["USD", "JPY"]);
  assert.deepEqual(orderPair("GBP", "EUR"), ["EUR", "GBP"]);
  assert.deepEqual(orderPair("SGD", "CAD"), ["CAD", "SGD"]);
  assert.deepEqual(orderPair("JPY", "SEK"), ["JPY", "SEK"]);
  assert.deepEqual(orderPair("SEK", "JPY"), ["JPY", "SEK"]);
});

test("rounding: two places, half away from zero, never negative zero", () => {
  assert.equal(round2(new Decimal("2.345")).toFixed(2), "2.35");
  assert.equal(round2(new Decimal("-2.345")).toFixed(2), "-2.35");
  assert.equal(round2(new Decimal("-0.004")).toFixed(2), "0.00");
});

test("filter: legal entities, FX-relevant and monetary accounts, functional-currency balances; every balance counted once", () => {
  const rows = [
    bal("US01", "4000", "EUR", "100"), bal("REG", "4000", "EUR", "1"), bal("GONE", "4000", "EUR", "1"), bal("US01", "9000", "EUR", "1"), bal("US01", "9100", "EUR", "1"),
    bal("US01", "7777", "EUR", "1"), bal("US01", "4000", "USD", "5"), bal("NOFC", "4000", "EUR", "1"),
  ];
  const { kept, counts } = filterBalances(rows, entities, accounts);
  assert.equal(kept.length, 1);
  assert.deepEqual(counts, { received: 8, kept: 1, notLegalEntity: 2, accountNotInScope: 3, functionalCurrency: 1, noFunctionalCurrency: 1 });
  assert.equal(counts.kept + counts.notLegalEntity + counts.accountNotInScope + counts.functionalCurrency + counts.noFunctionalCurrency, counts.received);
});

test("baseline: two opposite legs; transaction leg as sent, other leg rounded per row (workbook formulas)", () => {
  const { kept } = filterBalances([bal("US01", "4000", "EUR", "1718000"), bal("DE01", "4000", "USD", "1888000"), bal("UK01", "4000", "USD", "-1000.3333")], entities, accounts);
  const rows = buildBaseline(kept, rateOf, () => "AMER");
  // functional USD, transaction EUR: pair EUR-USD, other leg = -(1718000 x 1.1)
  assert.deepEqual([rows[0]!.pair, rows[0]!.amount1.toFixed(2), rows[0]!.amount2.toFixed(2)], ["EUR-USD", "1718000.00", "-1889800.00"]);
  // functional EUR, transaction USD: pair EUR-USD, currency 1 is the functional currency, so divide: -(1888000 / 1.1)
  assert.deepEqual([rows[1]!.pair, rows[1]!.amount1.toFixed(2), rows[1]!.amount2.toFixed(2)], ["EUR-USD", "-1716363.64", "1888000.00"]);
  // functional GBP, transaction USD: pair GBP-USD; the sign of the balance is kept as sent
  assert.deepEqual([rows[2]!.pair, rows[2]!.amount1.toFixed(2), rows[2]!.amount2.toFixed(4)], ["GBP-USD", "800.27", "-1000.3333"]);
});

const sample = () => {
  const { kept } = filterBalances([
    bal("US01", "4000", "EUR", "1000"), bal("US01", "4000", "GBP", "-400"), bal("DE01", "4000", "USD", "550"), bal("UK01", "4000", "EUR", "-100"),
  ], entities, accounts);
  const regions: Record<string, string> = { US01: "AMER", DE01: "EMEA", UK01: "EMEA" };
  return buildBaseline(kept, rateOf, (c) => regions[c]!);
};

test("group natural: one group per pair and period; long, short and net on currency 1; display amount from currency 1", () => {
  const groups = netByLevel(sample(), "GROUP_NATURAL", "2026-11-09", "USD", rateOf);
  const eurUsd = groups.find((g) => g.pair === "EUR-USD")!;
  // US01 +1000 EUR (-1100 USD); DE01 550 USD = -500 EUR (+550 USD)
  assert.deepEqual([eurUsd.long1.toFixed(2), eurUsd.short1.toFixed(2), eurUsd.net1.toFixed(2), eurUsd.net2.toFixed(2)], ["1000.00", "-500.00", "500.00", "-550.00"]);
  assert.deepEqual([eurUsd.exposureCurrency, eurUsd.displayRate, eurUsd.displayAmount.toFixed(2), eurUsd.members.length], ["EUR", "1.1", "550.00", 2]);
  const gbpUsd = groups.find((g) => g.pair === "GBP-USD")!;
  assert.deepEqual([gbpUsd.net1.toFixed(2), gbpUsd.displayAmount.toFixed(2)], ["-400.00", "-500.00"]);
  assert.deepEqual(groups.map((g) => g.pair), ["EUR-GBP", "EUR-USD", "GBP-USD"]);
});

test("every level nets by currency pair and period within its partition; members add up to the group", () => {
  const rows = sample();
  const level = (l: Parameters<typeof netByLevel>[1]) => netByLevel(rows, l, "2026-11-09", "USD", rateOf);
  assert.equal(level("GROUP_NATURAL").length, 3);
  assert.deepEqual(level("REGION").map((g) => [g.pair, g.region, g.entityCode]), [["EUR-GBP", "EMEA", null], ["EUR-USD", "AMER", null], ["EUR-USD", "EMEA", null], ["GBP-USD", "AMER", null]]);
  assert.deepEqual(level("REGION_BY_ENTITY").map((g) => [g.pair, g.region, g.entityCode]), [["EUR-GBP", "EMEA", "UK01"], ["EUR-USD", "AMER", "US01"], ["EUR-USD", "EMEA", "DE01"], ["GBP-USD", "AMER", "US01"]]);
  assert.deepEqual(level("ENTITY").map((g) => [g.pair, g.region, g.entityCode]), [["EUR-GBP", null, "UK01"], ["EUR-USD", null, "DE01"], ["EUR-USD", null, "US01"], ["GBP-USD", null, "US01"]]);
  for (const l of ["GROUP_NATURAL", "REGION", "REGION_BY_ENTITY", "ENTITY"] as const) {
    for (const g of level(l)) {
      assert.equal(g.members.reduce((a, m) => a.plus(m.amount1), new Decimal(0)).toFixed(4), g.net1.toFixed(4));
      assert.equal(g.members.reduce((a, m) => a.plus(m.amount2), new Decimal(0)).toFixed(4), g.net2.toFixed(4));
    }
  }
});

test("group portfolio: each row is re-paired against the display currency, so a non-USD pair becomes two USD legs that net with others", () => {
  const rows = sample();
  const re = repairToPortfolio(rows, "USD", (c) => rateOf(c, "USD"));
  // the EUR-GBP row (UK01 -100 EUR, GBP leg) gives an EUR leg and a GBP leg
  assert.equal(re.filter((c) => c.entityCode === "UK01").length, 2);
  const groups = netByLevel(rows, "GROUP_PORTFOLIO", "2026-11-09", "USD", rateOf);
  assert.deepEqual(groups.map((g) => g.pair), ["EUR-USD", "GBP-USD"]);
  const eur = groups.find((g) => g.pair === "EUR-USD")!;
  // EUR legs: +1000 (US01), -500 (DE01), -100 (UK01); the USD leg of each is the converted amount, rounded per row
  assert.equal(eur.net1.toFixed(2), "400.00");
  assert.equal(eur.exposureCurrency, "EUR");
  assert.equal(eur.members.length, 3);
});

test("exposure currency: the non-display currency when the pair holds the display currency, otherwise currency 2", () => {
  assert.equal(exposureCurrencyOf("EUR", "USD", "USD"), "EUR");
  assert.equal(exposureCurrencyOf("USD", "JPY", "USD"), "JPY");
  assert.equal(exposureCurrencyOf("EUR", "GBP", "USD"), "GBP");
});

test("required rates: the pair rates, and the display rates for each currency 1 (portfolio: for each currency)", () => {
  const { kept } = filterBalances([bal("UK01", "4000", "EUR", "1")], entities, accounts);
  assert.deepEqual(requiredRates(kept, "GROUP_NATURAL", "USD").map((r) => `${r.base}-${r.quote}:${r.purpose}`), ["EUR-GBP:PAIR", "EUR-USD:DISPLAY"]);
  assert.deepEqual(requiredRates(kept, "GROUP_PORTFOLIO", "USD").map((r) => `${r.base}-${r.quote}:${r.purpose}`), ["EUR-GBP:PAIR", "EUR-USD:PORTFOLIO", "GBP-USD:PORTFOLIO"]);
});
