import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExecutedFile, toPreTradeFile, type OutRow } from "../../services/fx-trade/src/file.ts";
import { generate } from "./generate.ts";
import { simulate } from "./simulate.ts";

const single: OutRow = { reference: "PT-AAAAAAAAAAAA", programId: "BS-ENT", tradingEntity: "US1", instrument: "FORWARD", leg: "SINGLE", buySell: "SELL", dealCurrency: "EUR", dealAmount: "100.0000", settlementCurrency: "USD", settlementAmount: null, valueDate: "2027-02-20", fixingDate: null };
const near: OutRow = { ...single, reference: "PT-BBBBBBBBBBBB", instrument: "SWAP", leg: "NEAR", valueDate: "2026-11-24" };
const far: OutRow = { ...near, leg: "FAR", valueDate: "2027-02-20", buySell: "BUY" };
const rates = "base,quote,type,value_date,all_in\nEUR,USD,SPOT,,1.1000000000\nEUR,USD,FORWARD,2027-02-20,1.1200000000\n";
const options = { pretrades: toPreTradeFile([single, near, far]), rates, tradeDate: "2026-11-20", seed: "42", portfolioByProgram: { "BS-ENT": "DEMO" } };

test("simulator generates valid executed rows with rate-derived amounts and whole swap legs", () => {
  const text = simulate(options);
  assert.equal(text, simulate(options));
  const rows = parseExecutedFile(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.settlementAmount), ["112.0000", "110.0000", "112.0000"]);
  assert.equal(rows[1]!.tradeId, rows[2]!.tradeId);
  assert.deepEqual(rows.map((r) => r.preTradeReference), [single.reference, near.reference, near.reference]);
  assert.ok(rows.every((r) => r.platform === "SIMFX" && r.portfolio === "DEMO" && r.tradeDate === "2026-11-20"));
});

test("partial and rejection select complete pre-trades deterministically", () => {
  const half = parseExecutedFile(simulate({ ...options, partial: 0.5 }));
  assert.equal(new Set(half.map((r) => r.preTradeReference)).size, 1);
  assert.equal(parseExecutedFile(simulate({ ...options, reject: 1 })).length, 0);
  assert.equal(parseExecutedFile(simulate({ ...options, partial: 0 })).length, 0);
});

test("missing rate and malformed swap refuse simulation", () => {
  assert.throws(() => simulate({ ...options, rates: "base,quote,type,value_date,all_in\nEUR,USD,SPOT,,1.1\n" }), /no FORWARD rate/);
  assert.throws(() => simulate({ ...options, pretrades: toPreTradeFile([near]) }), /invalid legs/);
});

test("a non-USD pair derives its settlement through the USD pivot", () => {
  const pretrades = toPreTradeFile([{ ...single, settlementCurrency: "GBP" }]);
  const crossRates = "base,quote,type,value_date,all_in\nEUR,USD,FORWARD,2027-02-20,1.2000000000\nGBP,USD,FORWARD,2027-02-20,1.5000000000\n";
  const [row] = parseExecutedFile(simulate({ ...options, pretrades, rates: crossRates }));
  assert.equal(row?.settlementAmount, "80.0000");
});

test("inverse rates, four-place rounding, and NDF fixing data survive the executed layout", () => {
  const ndf = { ...single, reference: "PT-NDF000000001", dealCurrency: "USD", settlementCurrency: "INR", dealAmount: "1.0000", fixingDate: "2027-02-18" };
  const inverse = "base,quote,type,value_date,all_in\nINR,USD,FORWARD,2027-02-20,0.3000000000\n";
  const [row] = parseExecutedFile(simulate({ ...options, pretrades: toPreTradeFile([ndf]), rates: inverse }));
  assert.equal(row?.settlementAmount, "3.3333");
  assert.equal(row?.fixingDate, "2027-02-18");
  assert.equal(row?.settlementCurrency, "INR");
});

test("forward quotes interpolate by calendar day without extrapolation", () => {
  const trade = { ...single, valueDate: "2027-01-06" };
  const curve = "base,quote,type,value_date,all_in\nEUR,USD,FORWARD,2027-01-01,1.1000000000\nEUR,USD,FORWARD,2027-01-11,1.3000000000\n";
  const [row] = parseExecutedFile(simulate({ ...options, pretrades: toPreTradeFile([trade]), rates: curve }));
  assert.equal(row?.settlementAmount, "120.0000");
  assert.throws(() => simulate({ ...options, pretrades: toPreTradeFile([{ ...trade, valueDate: "2027-01-12" }]), rates: curve }), /no FORWARD rate/);
});

test("trade IDs remain distinct across same-day files and match generated holiday forwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "uat-simulator-rates-"));
  try {
    await generate(20261120, root);
    const rates = await readFile(join(root, "rates/rates-2026-11-20.csv"), "utf8");
    const holidayTrade = { ...single, valueDate: "2027-02-23" };
    const first = parseExecutedFile(simulate({ ...options, pretrades: toPreTradeFile([holidayTrade]), rates }));
    const second = parseExecutedFile(simulate({ ...options, pretrades: toPreTradeFile([{ ...holidayTrade, reference: "PT-CCCCCCCCCCCC" }]), rates }));
    assert.equal(first.length, 1);
    assert.ok(Number(first[0]!.settlementAmount) > 0);
    assert.notEqual(first[0]!.tradeId, second[0]!.tradeId);
    const closeOut = { ...single, reference: "PT-NOVCLOSEOUT", buySell: "BUY" as const, valueDate: "2026-11-27" };
    const roll = { ...single, reference: "PT-NOVROLL0001", valueDate: "2027-02-23" };
    const scenarioEight = toPreTradeFile([closeOut, roll]);
    const executed = parseExecutedFile(simulate({ ...options, pretrades: scenarioEight, rates }));
    assert.deepEqual(executed.map((trade) => [trade.instrument, trade.leg, trade.preTradeReference, trade.valueDate]), [
      ["FORWARD", null, closeOut.reference, closeOut.valueDate], ["FORWARD", null, roll.reference, roll.valueDate],
    ]);
    assert.ok(executed.every((trade) => Number(trade.settlementAmount) > 0));
    const withoutOneWeek = rates.split("\n").filter((line) => !line.startsWith("EUR,USD,FORWARD,1W,")).join("\n");
    assert.throws(() => simulate({ ...options, pretrades: scenarioEight, rates: withoutOneWeek }), /no FORWARD rate.*2026-11-27/);
    const octoberRates = await readFile(join(root, "rates/rates-2026-10-29.csv"), "utf8");
    const scenarioFive = toPreTradeFile([{ ...single, dealCurrency: "BRL", settlementCurrency: "AED", valueDate: "2027-01-28" }]);
    const [scenarioFiveExecution] = parseExecutedFile(simulate({ ...options, tradeDate: "2026-10-29", pretrades: scenarioFive, rates: octoberRates }));
    assert.ok(scenarioFiveExecution && Number(scenarioFiveExecution.settlementAmount) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
