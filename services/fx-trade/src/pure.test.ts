import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExecutedFile, splitCsv, toPreTradeFile } from "./file.ts";
import { fixed4, fromUnits, legProblems, matchTrade, misfit, type LegInput, type OpenPreTrade } from "./model.ts";

const leg = (over: Partial<LegInput> = {}): LegInput => ({ role: "SINGLE", direction: "SELL", dealCurrency: "EUR", dealAmount: "1000000", settlementCurrency: "USD", settlementAmount: null, valueDate: "2026-12-15", fixingDate: null, ...over });

test("amounts keep four places and compare as numbers", () => {
  assert.equal(fixed4("100"), "100.0000");
  assert.equal(fixed4("007.5"), "7.5000");
  assert.equal(fromUnits(1234500n), "123.4500");
  assert.equal(fromUnits(-5n), "-0.0005");
});

test("leg rules by instrument", () => {
  assert.deepEqual(legProblems("FORWARD", [leg()], false), []);
  assert.deepEqual(legProblems("SPOT", [leg({ settlementAmount: "1100000" })], true), []);
  assert.match(legProblems("FORWARD", [leg({ settlementAmount: null })], true).join(), /settlement amount/);
  assert.match(legProblems("FORWARD", [leg({ dealCurrency: "USD" })], false).join(), /must differ/);
  assert.match(legProblems("FORWARD", [leg({ dealAmount: "0" })], false).join(), /positive/);
  assert.match(legProblems("FORWARD", [leg({ dealAmount: "1.23456" })], false).join(), /4 decimals/);
  assert.match(legProblems("FORWARD", [leg({ valueDate: "2026-02-30" })], false).join(), /not a date/);
  assert.match(legProblems("FORWARD", [leg({ fixingDate: "2026-12-10" })], false).join(), /only an NDF/);
  assert.match(legProblems("NDF", [leg()], false).join(), /fixing date/);
  assert.deepEqual(legProblems("NDF", [leg({ dealCurrency: "BRL", fixingDate: "2026-12-11" })], false), []);
  assert.match(legProblems("NDF", [leg({ fixingDate: "2026-12-20" })], false).join(), /after the value date/);
  assert.match(legProblems("FORWARD", [leg({ role: "NEAR" }), leg({ role: "FAR" })], false).join(), /one leg/);
});

test("a swap needs near and far legs in opposite directions, same pair, far later", () => {
  const near = leg({ role: "NEAR", direction: "BUY", valueDate: "2026-11-30" });
  const far = leg({ role: "FAR", direction: "SELL", valueDate: "2026-12-31" });
  assert.deepEqual(legProblems("SWAP", [near, far], false), []);
  assert.match(legProblems("SWAP", [near], false).join(), /near leg and a far leg/);
  assert.match(legProblems("SWAP", [near, { ...far, direction: "BUY" }], false).join(), /opposite/);
  assert.match(legProblems("SWAP", [near, { ...far, valueDate: "2026-11-30" }], false).join(), /later/);
  assert.match(legProblems("SWAP", [near, { ...far, settlementCurrency: "GBP" }], false).join(), /same currency pair/);
});

const open = (id: string, over: Partial<OpenPreTrade> = {}): OpenPreTrade => ({
  preTradeId: id, reference: `PT-${id}`, programId: "BS", tradingEntityCode: "US01", instrument: "FORWARD", legs: [leg()], remaining: "1000000.0000", ...over,
});
const subject = (over: object = {}) => ({ programId: "BS", tradingEntityCode: "US01", instrument: "FORWARD" as const, legs: [leg({ settlementAmount: "1100000" })], ...over });

test("a pre-trade fits on program, entity, instrument, direction, pair, value date, and room", () => {
  assert.equal(misfit(subject(), open("a")), null);
  assert.match(misfit(subject({ programId: "CF" }), open("a"))!, /program/);
  assert.match(misfit(subject({ tradingEntityCode: "DE01" }), open("a"))!, /entity/);
  assert.match(misfit(subject({ legs: [leg({ direction: "BUY" })] }), open("a"))!, /direction/);
  assert.match(misfit(subject({ legs: [leg({ valueDate: "2026-12-16" })] }), open("a"))!, /value dates/);
  assert.equal(misfit(subject({ legs: [leg({ dealAmount: "400000" })] }), open("a")), null, "a part fill fits");
  assert.match(misfit(subject({ legs: [leg({ dealAmount: "400000" })] }), open("a", { remaining: "300000.0000" }))!, /still open/);
});

test("a swap fills whole or not at all", () => {
  const legs = [leg({ role: "NEAR", direction: "BUY", valueDate: "2026-11-30" }), leg({ role: "FAR", direction: "SELL", valueDate: "2026-12-31" })];
  const p = open("s", { instrument: "SWAP", legs });
  assert.equal(misfit({ ...subject(), instrument: "SWAP", legs }, p), null);
  assert.match(misfit({ ...subject(), instrument: "SWAP", legs: [{ ...legs[0]!, dealAmount: "500000" }, legs[1]!] }, p)!, /whole/);
  assert.match(misfit({ ...subject(), instrument: "SWAP", legs }, { ...p, remaining: "0.0000" })!, /whole/);
});

test("matching: reference first and it must fit; otherwise exactly one open pre-trade", () => {
  const a = open("a");
  assert.deepEqual(matchTrade(subject(), "PT-a", a, [a]), { status: "MATCHED", preTradeId: "a", note: null, candidates: [] });
  assert.equal(matchTrade(subject({ legs: [leg({ direction: "BUY" })] }), "PT-a", a, [a]).status, "UNMATCHED");
  assert.deepEqual(matchTrade(subject({ legs: [leg({ direction: "BUY" })] }), "PT-a", a, [a]).candidates, ["a"]);
  assert.match(matchTrade(subject(), "PT-zz", null, [a]).note!, /no open pre-trade has the reference/);
  assert.equal(matchTrade(subject(), null, null, [a]).preTradeId, "a");
  assert.equal(matchTrade(subject(), null, null, []).status, "UNMATCHED");
  const two = matchTrade(subject(), null, null, [open("b"), a]);
  assert.deepEqual([two.status, two.preTradeId, two.candidates], ["AMBIGUOUS", null, ["a", "b"]]);
  assert.match(matchTrade(subject({ programId: null }), "PT-a", a, [a]).note!, /no program/);
});

test("the file reader handles quotes, case, unknown columns and swap legs", () => {
  assert.deepEqual(splitCsv('a,"b,1",c\r\n\r\n"x ""q""",,z\n'), [["a", "b,1", "c"], ['x "q"', "", "z"]]);
  const rows = parseExecutedFile(
    "Trade ID,Execution Platform ID,Trading Entity,Trade Date,Value Date,Deal Currency,Deal Amount,Settlement Currency,Settlement Amount,Instrument,Buy Sell,Hedging Program ID,Leg,Desk\n" +
      "T1,FXALL,US01,2026-11-10,2026-12-15,EUR,1000000,USD,1100000,Forward,SELL,BS,,NY\n" +
      "T2,FXALL,US01,2026-11-10,2026-11-30,EUR,500000,USD,550000,Swap,buy,BS,near,\n",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0]!.tradeId, rows[0]!.instrument, rows[0]!.leg, rows[0]!.custom], ["T1", "Forward", null, { desk: "NY" }]);
  assert.deepEqual([rows[1]!.leg, rows[1]!.buySell, rows[1]!.rowNo], ["NEAR", "buy", 2]);
});

test("the outbound file has one row per leg and quotes what needs it", () => {
  const f = toPreTradeFile([{ reference: "PT-1", programId: "BS", tradingEntity: 'US,01', instrument: "FORWARD", leg: "SINGLE", buySell: "SELL", dealCurrency: "EUR", dealAmount: "1.0000", settlementCurrency: "USD", settlementAmount: null, valueDate: "2026-12-15", fixingDate: null }]);
  assert.equal(f.split("\n")[1], 'PT-1,BS,"US,01",FORWARD,,SELL,EUR,1.0000,USD,,2026-12-15,');
});
