import { test } from "node:test";
import assert from "node:assert/strict";
import { cross, fix, invert, weakest } from "./derive.ts";
import { Decimal } from "decimal.js";
import { qualityOf, RatesInvalid, validateRates } from "./validate.ts";
import type { RateRow } from "./rows.ts";

const NOW = new Date("2026-03-10T12:00:00Z");
const spot = (base: string, quote: string, allIn: string, over: Partial<RateRow> = {}): RateRow => ({
  base, quote, type: "SPOT", tenor: "SPOT", valueDate: null, allIn, spot: null, forwardPoints: null, bid: null, mid: null, ask: null,
  observedAt: "2026-03-09T21:00:00Z", ...over,
});

test("inverse and cross round once, to 10 places", () => {
  assert.equal(invert("4"), "0.2500000000");
  assert.equal(invert("1.25"), "0.8000000000");
  assert.equal(cross({ rate: "1.1", derivation: "DIRECT" }, { rate: "150", derivation: "DIRECT" }), "165.0000000000");
  // EUR/JPY from EUR/USD and USD/JPY, and from USD/EUR inverted
  assert.equal(cross({ rate: "0.8", derivation: "INVERSE" }, { rate: "150", derivation: "DIRECT" }), "187.5000000000");
  assert.equal(fix(new Decimal("1.00000000005")), "1.0000000001");
});

test("a derived rate shows its weakest quality", () => {
  assert.equal(weakest(["VALID", "VALID"]), "VALID");
  assert.equal(weakest(["VALID", "OUTLIER"]), "OUTLIER");
  assert.equal(weakest(["OUTLIER", "STALE"]), "STALE");
});

test("a good load passes; the usual mistakes are each named", () => {
  assert.deepEqual(validateRates([spot("EUR", "USD", "1.0850000000")], "2026-03-09", NOW), []);
  const bad = validateRates(
    [
      spot("EUR", "EUR", "1"),
      spot("eur", "USD", "1"),
      spot("GBP", "USD", "0"),
      spot("GBP", "JPY", "1.12345678901"),
      spot("CHF", "USD", "1.1", { bid: "1.2", ask: "1.1" }),
      spot("AUD", "USD", "0.6", { tenor: "1M" }),
      spot("CAD", "USD", "0.7", { observedAt: "2026-03-11T00:00:00Z" }),
      spot("NZD", "USD", "0.6"),
      spot("NZD", "USD", "0.6"),
      { ...spot("SEK", "USD", "0.1"), type: "FORWARD", tenor: "SPOT" },
      { ...spot("NOK", "USD", "0.1"), type: "FORWARD", tenor: "1M", spot: "0.1", forwardPoints: "0.01" },
    ],
    "2026-03-09",
    NOW,
  );
  const text = bad.join("\n");
  for (const part of ["must differ", "three capital letters", "must be positive", "at most 10 places", "bid cannot exceed ask", "spot rate has tenor SPOT", "in the future", "appears twice", "needs a tenor code", "spot plus forward points"]) {
    assert.match(text, new RegExp(part), part);
  }
});

test("future business date and an empty load are refused", () => {
  assert.match(validateRates([spot("EUR", "USD", "1.1")], "2026-03-11", NOW).join(), /in the future/);
  assert.match(validateRates([], "2026-03-09", NOW).join(), /at least one/);
  assert.match(validateRates([spot("EUR", "USD", "1.1")], "2026-02-30x", NOW).join(), /not a date/);
  assert.throws(() => { throw new RatesInvalid(["a", "b"]); }, /a; b/);
});

test("forward consistency uses a tolerance of 1e-10", () => {
  const fwd = (allIn: string): RateRow => ({ ...spot("EUR", "USD", allIn), type: "FORWARD", tenor: "3M", spot: "1.0850000000", forwardPoints: "0.0050000000" });
  assert.deepEqual(validateRates([fwd("1.0900000000")], "2026-03-09", NOW), []);
  assert.deepEqual(validateRates([fwd("1.0900000001")], "2026-03-09", NOW), []);
  assert.equal(validateRates([fwd("1.0900000002")], "2026-03-09", NOW).length, 1);
});

test("quality: stale is measured to the end of the business date; outlier against the prior valid rate", () => {
  const eod = new Date("2026-03-10T00:00:00Z");
  const at = new Date("2026-03-09T21:00:00Z"); // three hours before the end of the date
  assert.equal(qualityOf(at, eod, null, "1.10", null, 0.1), "VALID");
  assert.equal(qualityOf(at, eod, 240, "1.10", null, 0.1), "VALID");
  assert.equal(qualityOf(at, eod, 120, "1.10", null, 0.1), "STALE");
  assert.equal(qualityOf(at, eod, null, "1.22", "1.10", 0.1), "OUTLIER");
  assert.equal(qualityOf(at, eod, null, "1.21", "1.10", 0.1), "VALID");
  assert.equal(qualityOf(at, eod, 120, "2", "1", 0.1), "STALE", "stale outranks outlier");
});
