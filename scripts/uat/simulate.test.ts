import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExecutedFile, toPreTradeFile, type OutRow } from "../../services/fx-trade/src/file.ts";
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
