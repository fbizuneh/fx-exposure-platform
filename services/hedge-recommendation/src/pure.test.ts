import { test } from "node:test";
import assert from "node:assert/strict";
import { D, addTenor, pairKey, recommend, roundDownToStep, valueDateFor, businessDaysBefore, calendarGaps, noCalendar, rollModifiedFollowing, toBusinessCalendar } from "./calc.ts";
import { policyProblems } from "./policy.ts";

const base = { grossExposure: "1000000", hedgedAmount: "0", ratio: "1", rounding: "1000", minExposure: null, rateMissing: false } as const;

test("rounding goes down toward zero to the step, for either sign", () => {
  assert.equal(roundDownToStep(new D("234430"), new D("1000")).toString(), "234000");
  assert.equal(roundDownToStep(new D("-234430"), new D("1000")).toString(), "-234000");
  assert.equal(roundDownToStep(new D("999"), new D("1000")).toString(), "0");
});

test("a long exposure with nothing hedged recommends selling the target ratio, rounded down", () => {
  const r = recommend({ ...base, grossExposure: "234430.55" });
  assert.deepEqual([r.action, r.direction, r.amount!.toString(), r.target.toString(), r.needed.toString()], ["HEDGE", "SELL", "234000", "-234430.55", "-234430.55"]);
  const half = recommend({ ...base, grossExposure: "234430.55", ratio: "0.5" });
  assert.equal(half.amount!.toString(), "117000");
});

test("only the gap to the target is recommended; an over-hedge is bought back; on target is no action", () => {
  assert.equal(recommend({ ...base, hedgedAmount: "-600000" }).amount!.toString(), "400000");
  const over = recommend({ ...base, hedgedAmount: "-1300000" });
  assert.deepEqual([over.direction, over.amount!.toString()], ["BUY", "300000"]);
  const exact = recommend({ ...base, hedgedAmount: "-1000000" });
  assert.deepEqual([exact.action, exact.reason], ["NONE", "WITHIN_TARGET"]);
});

test("a short exposure is hedged by buying", () => {
  const r = recommend({ ...base, grossExposure: "-50000" });
  assert.deepEqual([r.direction, r.amount!.toString()], ["BUY", "50000"]);
});

test("rounds to zero, below the minimum (tested after rounding, in the exposure currency), and a missing rate", () => {
  assert.equal(recommend({ ...base, grossExposure: "999" }).reason, "ROUNDS_TO_ZERO");
  assert.equal(recommend({ ...base, grossExposure: "10500", minExposure: "11000" }).reason, "BELOW_MINIMUM", "rounds to 10,000 which is under 11,000");
  assert.equal(recommend({ ...base, grossExposure: "11999", minExposure: "11000" }).amount!.toString(), "11000", "the minimum itself passes");
  assert.equal(recommend({ ...base, rateMissing: true }).reason, "NO_RATE");
});

test("value date: tenor from the as-of date, month ends clamp, and weekends roll forward", () => {
  assert.equal(addTenor("2026-01-31", "1M"), "2026-02-28");
  assert.equal(addTenor("2026-11-12", "2W"), "2026-11-26");
  assert.equal(addTenor("2026-11-30", "3M"), "2027-02-28");
  const weekends = [noCalendar("EUR"), noCalendar("USD")];
  assert.equal(valueDateFor("2026-11-12", "1M", weekends), "2026-12-14", "2026-12-12 is a Saturday");
  assert.equal(businessDaysBefore("2026-12-14", 2, weekends), "2026-12-10", "two business days before a Monday is the Thursday");
});

const cal = (currency: string, holidays: string[], over: { weekendDays?: string[]; coveredThrough?: string } = {}) =>
  toBusinessCalendar({ currency, weekendDays: over.weekendDays ?? ["SAT", "SUN"], coveredThrough: over.coveredThrough ?? "2027-12-31", holidays: holidays.map((date) => ({ date })) });

test("business days: a day must be open in every calendar of the pair; modified following stays in the month; fixing counts back over the joint calendar", () => {
  const eur = cal("EUR", ["2026-12-25"]);
  const usd = cal("USD", ["2026-11-26", "2026-12-24"]);
  // Open in one currency and closed in the other is not a business day for the pair.
  assert.equal(rollModifiedFollowing("2026-11-26", [eur, usd]), "2026-11-27", "a US holiday rolls an EUR-USD value date");
  assert.equal(rollModifiedFollowing("2026-11-26", [eur]), "2026-11-26", "but not an EUR-only one");
  assert.equal(rollModifiedFollowing("2026-12-24", [eur, usd]), "2026-12-28", "24th US holiday, 25th EUR holiday, then the weekend");
  // Month end: a following roll would leave the month, so it goes back instead. 2026-10-31 is a Saturday.
  assert.equal(rollModifiedFollowing("2026-10-31", [eur, usd]), "2026-10-30");
  assert.equal(rollModifiedFollowing("2026-12-31", [eur, usd]), "2026-12-31", "a business day stays put");
  assert.equal(rollModifiedFollowing("2026-07-31", [noCalendar("EUR")]), "2026-07-31");
  // Fixing: two joint business days before the value date, skipping a holiday of either currency.
  assert.equal(businessDaysBefore("2026-11-27", 2, [eur, usd]), "2026-11-24", "the 26th is a US holiday and the 25th is open: 25th, then the 24th");
  assert.equal(businessDaysBefore("2026-11-27", 2, [eur]), "2026-11-25");
  // A currency with a Friday and Saturday weekend: Friday the 13th is closed in SAR, Sunday the 15th is closed in EUR, so the first joint day is Monday the 16th.
  const gulf = cal("SAR", [], { weekendDays: ["FRI", "SAT"] });
  assert.equal(rollModifiedFollowing("2026-11-13", [eur, gulf]), "2026-11-16");
  assert.equal(rollModifiedFollowing("2026-11-12", [eur, gulf]), "2026-11-12", "Thursday is open in both");
});

test("calendar gaps: none on record, or holidays known only to an earlier date", () => {
  const through = "2026-12-14";
  assert.deepEqual(calendarGaps([noCalendar("BRL"), cal("USD", [], { coveredThrough: "2026-12-31" })], through), [{ currency: "BRL", reason: "NO_CALENDAR" }]);
  assert.deepEqual(calendarGaps([cal("EUR", [], { coveredThrough: "2026-12-13" }), cal("USD", [])], through), [{ currency: "EUR", reason: "CALENDAR_ENDED" }]);
  assert.deepEqual(calendarGaps([cal("EUR", [], { coveredThrough: "2026-12-14" })], through), [], "covered through the value date is covered");
});

test("a policy is checked before it is saved", () => {
  const ok = { defaultRatio: "1", ratioOverrides: [], minHedgeDisplay: "0", roundingDefault: "1000", roundingOverrides: [], tenor: "1M", tradingEntityCode: "US01" };
  assert.deepEqual(policyProblems(ok), []);
  const bad = policyProblems({ ...ok, defaultRatio: "-1", roundingDefault: "0", tenor: "monthly", ratioOverrides: [{ pair: "EURUSD", ratio: "1" }], roundingOverrides: [{ currency: "EUR", rounding: "100" }, { currency: "EUR", rounding: "10" }] });
  assert.equal(bad.length, 5);
});

test("a pair override is the same pair whichever currency is written first, and a pair of one currency is rejected", () => {
  assert.equal(pairKey("USD-EUR"), pairKey("EUR-USD"));
  const ok = { defaultRatio: "1", ratioOverrides: [], minHedgeDisplay: "0", roundingDefault: "1000", roundingOverrides: [], tenor: "1M", tradingEntityCode: null };
  assert.deepEqual(policyProblems({ ...ok, ratioOverrides: [{ pair: "USD-EUR", ratio: "0.5" }] }), []);
  assert.match(policyProblems({ ...ok, ratioOverrides: [{ pair: "EUR-USD", ratio: "0.5" }, { pair: "USD-EUR", ratio: "0.8" }] })[0]!, /appears twice/);
  assert.match(policyProblems({ ...ok, ratioOverrides: [{ pair: "EUR-EUR", ratio: "0.5" }] })[0]!, /same currency twice/);
});
