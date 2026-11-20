import { test } from "node:test";
import assert from "node:assert/strict";
import { D, addTenor, amountThresholdNeed, finishRecommendation, pairKey, recommend, roundDownToStep, valueDateFor, businessDaysBefore, calendarGaps, noCalendar, rollModifiedFollowing, rollWithSpan, toBusinessCalendar } from "./calc.ts";
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

test("an expired calendar is not trusted for its weekend either: past its covered-through date only Saturdays and Sundays are closed, in the roll and in the fixing count", () => {
  const eur = cal("EUR", []);
  // A Friday/Saturday calendar known only to Thursday 10 December 2026.
  const gulf = cal("SAR", [], { weekendDays: ["FRI", "SAT"], coveredThrough: "2026-12-10" });
  assert.equal(rollModifiedFollowing("2026-12-11", [eur, gulf]), "2026-12-11", "Friday 11th is after the cover: Saturday/Sunday fallback, so it is open");
  assert.equal(rollModifiedFollowing("2026-12-12", [eur, gulf]), "2026-12-14", "the weekend after the cover is Saturday and Sunday: Monday");
  assert.equal(businessDaysBefore("2026-12-14", 2, [eur, gulf]), "2026-12-10", "Friday 11th counts as open, then Thursday the 10th (open: Thursday is not SAR's weekend)");
  // Inside the cover the calendar is still obeyed: Friday 4th is closed in SAR, Saturday 5th in both, Sunday 6th in EUR; Monday 7th is open in both.
  assert.equal(rollModifiedFollowing("2026-12-04", [eur, gulf]), "2026-12-07");
  // A holiday cannot be listed after the cover, so none applies there; with no calendar at all it is Saturday and Sunday.
  assert.equal(rollModifiedFollowing("2026-12-11", [eur, noCalendar("BRL")]), "2026-12-11");
  // The span reports the latest day looked at, which is what the gap check needs.
  assert.deepEqual(rollWithSpan("2026-10-31", [eur]), { date: "2026-10-30", through: "2026-11-02" }, "rolled back, but it looked at November 2nd first");
  assert.deepEqual(rollWithSpan("2026-12-11", [eur, gulf]), { date: "2026-12-11", through: "2026-12-11" });
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

import { splitAmount, MAX_PARTS } from "./calc.ts";
const split = (total: string, max: string | null, method: "EVEN" | "THRESHOLD_REMAINDER", step = "1", min: string | null = null) =>
  splitAmount(new D(total), max === null ? null : new D(max), method, new D(step), min === null ? null : new D(min));
const amounts = (s: { parts: { toString(): string }[] }) => s.parts.map((x) => x.toString());

test("split: the owner's example, 450 at a maximum of 200, is 3 parts either way", () => {
  assert.deepEqual(amounts(split("450", "200", "EVEN")), ["150", "150", "150"]);
  assert.deepEqual(amounts(split("450", "200", "THRESHOLD_REMAINDER")), ["200", "200", "50"]);
});
test("split: no maximum, or a total within it, is one part", () => {
  assert.deepEqual(amounts(split("450", null, "EVEN")), ["450"]);
  assert.deepEqual(amounts(split("200", "200", "THRESHOLD_REMAINDER")), ["200"]);
  assert.deepEqual(amounts(split("199", "200", "EVEN")), ["199"]);
});
test("split: even parts are whole steps, the leftover steps going to the first parts, and the parts add up", () => {
  const s = split("10000", "3000", "EVEN", "1000"); // 4 parts, 2500 each is not a step multiple
  assert.deepEqual(amounts(s), ["3000", "3000", "2000", "2000"]);
  assert.equal(s.parts.reduce((a, b) => a.plus(b), new D(0)).toString(), "10000");
  assert.deepEqual(amounts(split("10", "3", "EVEN")), ["3", "3", "2", "2"]);
});
test("split: threshold parts use the maximum rounded down to a step; an exact multiple has no remainder", () => {
  assert.deepEqual(amounts(split("5000", "1500", "THRESHOLD_REMAINDER", "1000")), ["1000", "1000", "1000", "1000", "1000"]);
  assert.deepEqual(amounts(split("600", "200", "THRESHOLD_REMAINDER")), ["200", "200", "200"]);
});
test("split: a last part below the minimum is added to the one before it; even parts below it use fewer parts", () => {
  const t = split("410", "200", "THRESHOLD_REMAINDER", "1", "50");
  assert.deepEqual(amounts(t), ["200", "210"]);
  assert.match(t.note!, /added to the part before/);
  assert.deepEqual(amounts(split("410", "200", "THRESHOLD_REMAINDER", "1", "5")), ["200", "200", "10"], "a remainder at or above the minimum stands alone");
  const e = split("250", "200", "EVEN", "1", "150"); // 125 and 125 are below 150
  assert.deepEqual(amounts(e), ["250"]);
  assert.match(e.note!, /Fewer parts/);
});
test("split: an override amount that is not a step multiple splits in the smallest unit; absurd counts are capped", () => {
  assert.deepEqual(amounts(split("100.5", "50", "EVEN", "1000")), ["33.5", "33.5", "33.5"]);
  assert.deepEqual(amounts(split("100.0001", "50", "EVEN", "1000")), ["33.3334", "33.3334", "33.3333"]);
  const huge = split("1000000", "1", "THRESHOLD_REMAINDER");
  assert.equal(huge.parts.length, MAX_PARTS);
  assert.equal(huge.parts.reduce((a, b) => a.plus(b), new D(0)).toString(), "1000000");
});

import { overallFollowUp } from "./decide.ts";
test("follow-up of the whole: executed when every part is, partly once any is, cancelled when every part is", () => {
  assert.equal(overallFollowUp(["EXECUTED", "EXECUTED"]), "EXECUTED");
  assert.equal(overallFollowUp(["EXECUTED", "OPEN"]), "PARTLY_EXECUTED");
  assert.equal(overallFollowUp(["PARTLY_EXECUTED", "OPEN"]), "PARTLY_EXECUTED");
  assert.equal(overallFollowUp(["EXECUTED", "CANCELLED"]), "EXECUTED_REST_CANCELLED", "every part is finished, some cancelled: closed out");
  assert.equal(overallFollowUp(["CANCELLED", "EXECUTED", "CANCELLED", "EXECUTED"]), "EXECUTED_REST_CANCELLED");
  assert.equal(overallFollowUp(["EXECUTED", "CANCELLED", "OPEN"]), "PARTLY_EXECUTED", "a live part keeps it open for follow-up");
  assert.equal(overallFollowUp(["EXECUTED", "CANCELLED", "PARTLY_EXECUTED"]), "PARTLY_EXECUTED", "a part that is only partly filled is still live");
  assert.equal(overallFollowUp(["CANCELLED", "OPEN"]), "OPEN");
  assert.equal(overallFollowUp(["CANCELLED", "CANCELLED"]), "CANCELLED");
  assert.equal(overallFollowUp(["OPEN", "CANCELLED"]), "OPEN");
  assert.equal(overallFollowUp(["NOT_STARTED"]), "NOT_STARTED");
});

test("split: a rounding step coarser than the pieces never makes a zero part, and the cap holds after the maximum is rounded down", () => {
  const coarse = split("1000", "400", "EVEN", "1000"); // three parts would be 1000, 0, 0
  assert.deepEqual(amounts(coarse), ["1000"]);
  assert.match(coarse.note!, /only 1 whole step of 1000, so it was split into 1 part, larger than the maximum/);
  const two = split("2000", "400", "EVEN", "1000"); // wants 5 parts, has 2 steps
  assert.deepEqual(amounts(two), ["1000", "1000"]);
  // 51,000 at a maximum of 1,999 passes a count check on the maximum (26 parts) but 1,000-unit parts of the rounded-down maximum would be 51.
  const many = split("51000", "1999", "THRESHOLD_REMAINDER", "1000");
  assert.equal(many.parts.length, MAX_PARTS);
  assert.equal(many.parts.reduce((a, b) => a.plus(b), new D(0)).toString(), "51000");
  assert.ok(many.parts.every((x) => x.gt(0) && x.mod(1000).isZero()));
  assert.match(many.note!, /50 parts, the most allowed/);
  // An enormous ratio is counted before it is built: 100 billion pieces of 0.01 would not fit in memory, and must not be attempted.
  for (const method of ["THRESHOLD_REMAINDER", "EVEN"] as const) {
    const huge = split("1000000000.07", "0.01", method, "0.01");
    assert.ok(huge.parts.length <= 50 && huge.parts.every((x) => x.gt(0)));
    assert.equal(huge.parts.reduce((s, x) => s.plus(x), new D(0)).toString(), "1000000000.07");
    assert.match(huge.note!, /50 parts, the most allowed/);
  }
});
test("split: whatever the inputs, parts are positive, add up exactly, are at most 50, and any part above the maximum has a note", () => {
  const methods = ["EVEN", "THRESHOLD_REMAINDER"] as const;
  for (const total of ["10", "250", "1000", "51000", "100.5", "0.0003"]) for (const max of ["0.0001", "3.5", "199", "333.33", "400", "1999"]) for (const step of ["1", "10", "1000"]) for (const min of [null, "50", "300"]) for (const m of methods) {
    const s = split(total, max, m, step, min);
    assert.ok(s.parts.length >= 1 && s.parts.length <= MAX_PARTS, `${total}/${max}/${step}/${min}/${m}: count`);
    assert.ok(s.parts.every((x) => x.gt(0)), `${total}/${max}/${step}/${min}/${m}: positive`);
    assert.equal(s.parts.reduce((a, b) => a.plus(b), new D(0)).toString(), new D(total).toString(), `${total}/${max}/${step}/${min}/${m}: sum`);
    if (s.parts.some((x) => x.gt(max)) && new D(total).gt(max)) assert.ok(s.note !== null, `${total}/${max}/${step}/${min}/${m}: a part above the maximum needs a note`);
  }
});

interface Thr { netExposure: string; hedgedAmount: string; thresholdExposure: string | null }
interface Fin { rounding: string; minExposure: string | null; rateMissing: boolean }
const thr: Thr = { netExposure: "1000000", hedgedAmount: "0", thresholdExposure: "250000" };
const finishing: Fin = { rounding: "1000", minExposure: null, rateMissing: false };
const amountThreshold = (n: Partial<Thr>, f: Partial<Fin> = {}) => finishRecommendation(amountThresholdNeed({ ...thr, ...n }), { ...finishing, ...f });

test("amount threshold: a net exposure larger than the threshold is hedged in full, either way, to bring the net to zero", () => {
  const long = amountThreshold({});
  assert.deepEqual([long.action, long.direction, long.amount!.toString(), long.needed.toString(), long.target.toString()], ["HEDGE", "SELL", "1000000", "-1000000", "-1000000"]);
  const short = amountThreshold({ netExposure: "-300000.5" }); // not the gross: the net after hedges decides
  assert.deepEqual([short.direction, short.amount!.toString()], ["BUY", "300000"], "rounded down to the step");
  const part = amountThreshold({ netExposure: "400000", hedgedAmount: "-600000" });
  assert.deepEqual([part.amount!.toString(), part.target.toString()], ["400000", "-1000000"], "the target is what is already hedged plus the whole net");
});

test("amount threshold: at the threshold or above it is hedged either way, only a net strictly below is within it, and the threshold cannot be compared without its rate", () => {
  for (const net of ["250000", "-250000", "250000.01", "-250000.01"]) assert.equal(amountThreshold({ netExposure: net }).action, "HEDGE", net);
  assert.deepEqual([amountThreshold({ netExposure: "250000" }).direction, amountThreshold({ netExposure: "-250000" }).direction], ["SELL", "BUY"]);
  for (const net of ["249999.99", "-249999.99", "0"]) assert.equal(amountThreshold({ netExposure: net }).reason, "WITHIN_THRESHOLD", net);
  const within = amountThreshold({ netExposure: "100000", hedgedAmount: "-50" });
  assert.deepEqual([within.action, within.needed.toString(), within.target.toString()], ["NONE", "0", "-50"]);
  assert.equal(amountThreshold({ thresholdExposure: null }).reason, "NO_RATE");
});

test("amount threshold: the threshold is compared as converted, not as rounded for display", () => {
  // 100,000.00004 would show as 100,000.0000; a net of exactly 100,000 is below the real threshold and must not be hedged.
  assert.equal(amountThreshold({ netExposure: "100000", thresholdExposure: "100000.00004" }).reason, "WITHIN_THRESHOLD");
  assert.equal(amountThreshold({ netExposure: "-100000", thresholdExposure: "100000.00004" }).reason, "WITHIN_THRESHOLD");
  // 99,999.99996 would show as 100,000.0000; a net of exactly 100,000 is above the real threshold and must be hedged.
  assert.equal(amountThreshold({ netExposure: "100000", thresholdExposure: "99999.99996" }).action, "HEDGE");
});

test("rounding and the minimum are the same rules for every strategy", () => {
  // The same needed amount, wanted by either strategy, gets the same rounding and minimum result.
  const viaRatio = finishRecommendation({ target: new D("-234430.55"), needed: new D("-234430.55"), reason: null }, { ...finishing, minExposure: "250000" });
  const viaThreshold = amountThreshold({ netExposure: "234430.55", thresholdExposure: "1" }, { minExposure: "250000" });
  assert.deepEqual([viaRatio.reason, viaThreshold.reason], ["BELOW_MINIMUM", "BELOW_MINIMUM"]);
  assert.equal(amountThreshold({ netExposure: "234430.55", thresholdExposure: "1" }).amount!.toString(), "234000");
  assert.equal(amountThreshold({ netExposure: "999", thresholdExposure: "1" }).reason, "ROUNDS_TO_ZERO");
  assert.equal(amountThreshold({}, { rateMissing: true }).reason, "NO_RATE");
});

test("a policy with the amount-threshold strategy needs a threshold, and the thresholds are checked", () => {
  const ok = { defaultRatio: "1", ratioOverrides: [], minHedgeDisplay: "0", roundingDefault: "1000", roundingOverrides: [], tenor: "1M", tradingEntityCode: "US01" };
  assert.deepEqual(policyProblems({ ...ok, strategy: "amount-threshold", amountThresholdDisplay: "250000", amountThresholdOverrides: [{ nettingLevel: "ENTITY", amountThresholdDisplay: "100000" }] }), []);
  assert.match(policyProblems({ ...ok, strategy: "amount-threshold" })[0]!, /needs an amount threshold/);
  assert.deepEqual(policyProblems({ ...ok, strategy: "hedge-ratio-adjustment", amountThresholdDisplay: "250000" }), [], "kept while the ratio strategy is in use");
  const bad = policyProblems({ ...ok, strategy: "var" as never, amountThresholdDisplay: "0", amountThresholdOverrides: [{ nettingLevel: "ENTITY", amountThresholdDisplay: "-1" }, { nettingLevel: "ENTITY", amountThresholdDisplay: "5" }, { nettingLevel: "DESK", amountThresholdDisplay: "5" }] });
  assert.equal(bad.length, 5, bad.join(" | "));
  assert.deepEqual(policyProblems({ ...ok, strategy: "amount-threshold", amountThresholdDisplay: "100", minHedgeDisplay: "500" }), [], "a threshold below the minimum is allowed; the minimum then decides");
});
