import { test } from "node:test";
import assert from "node:assert/strict";
import { combinationProblem, scheduledAsOf, validateSettings } from "./rules.ts";
import type { Schedule } from "../contract/index.ts";

const ok = { nettingLevel: "ENTITY_PAIR", bucketScheme: { kind: "DAYS", boundaries: [0, 30, 90] } as const, schedule: null };

test("settings: netting level, buckets and schedule are each checked", () => {
  assert.deepEqual(validateSettings(ok), []);
  assert.deepEqual(validateSettings({ ...ok, bucketScheme: { kind: "MONTHS" }, schedule: { frequency: "DAILY", asOfOffsetDays: 1 } }), []);
  assert.match(validateSettings({ ...ok, nettingLevel: "PORTFOLIO" }).join(), /netting level/);
  assert.match(validateSettings({ ...ok, bucketScheme: { kind: "DAYS", boundaries: [] } }).join(), /1 to 20/);
  assert.match(validateSettings({ ...ok, bucketScheme: { kind: "DAYS", boundaries: [30, 30] } }).join(), /ascending/);
  assert.match(validateSettings({ ...ok, bucketScheme: { kind: "DAYS", boundaries: [0, 1.5] } }).join(), /whole numbers/);
  assert.match(validateSettings({ ...ok, bucketScheme: { kind: "WEEKS" } as never }).join(), /DAYS or MONTHS/);
  assert.match(validateSettings({ ...ok, schedule: { frequency: "MONTHLY", dayOfMonth: 31, asOfOffsetDays: 1 } }).join(), /1 to 28/);
  assert.match(validateSettings({ ...ok, schedule: { frequency: "WEEKLY", dayOfWeek: 8 as never, asOfOffsetDays: 1 } }).join(), /1 \(Monday\)/);
  assert.match(validateSettings({ ...ok, schedule: { frequency: "DAILY", asOfOffsetDays: -1 } }).join(), /0 to 31/);
  assert.match(validateSettings({ ...ok, schedule: { frequency: "HOURLY", asOfOffsetDays: 0 } as never }).join(), /DAILY, WEEKLY or MONTHLY/);
});

test("combination rules: one balance sheet program; classic programs and Budget to Cash exclude each other", () => {
  assert.equal(combinationProblem([], "BALANCE_SHEET"), null);
  assert.match(combinationProblem(["BALANCE_SHEET"], "BALANCE_SHEET") ?? "", /only one balance sheet/);
  assert.equal(combinationProblem(["BALANCE_SHEET"], "CASH_FLOW"), null);
  assert.equal(combinationProblem(["BALANCE_SHEET", "CASH_FLOW"], "IN_HOUSE_BANK"), null);
  assert.match(combinationProblem(["CASH_FLOW"], "BUDGET_TO_CASH") ?? "", /Budget to Cash/);
  assert.match(combinationProblem(["BUDGET_TO_CASH"], "BALANCE_SHEET") ?? "", /Budget to Cash/);
  assert.equal(combinationProblem(["BUDGET_TO_CASH"], "BUDGET_TO_CASH"), null);
});

test("schedules: the as-of date is the run date minus the offset, only on the scheduled day", () => {
  const daily: Schedule = { frequency: "DAILY", asOfOffsetDays: 1 };
  assert.equal(scheduledAsOf(daily, "2026-03-02"), "2026-03-01");
  assert.equal(scheduledAsOf({ frequency: "DAILY", asOfOffsetDays: 0 }, "2026-03-02"), "2026-03-02");
  assert.equal(scheduledAsOf(daily, "2026-03-01"), "2026-02-28", "across a month end");
  const weekly: Schedule = { frequency: "WEEKLY", dayOfWeek: 1, asOfOffsetDays: 3 }; // Monday
  assert.equal(scheduledAsOf(weekly, "2026-03-02"), "2026-02-27"); // 2 March 2026 is a Monday
  assert.equal(scheduledAsOf(weekly, "2026-03-03"), null);
  assert.equal(scheduledAsOf({ frequency: "WEEKLY", dayOfWeek: 7, asOfOffsetDays: 0 }, "2026-03-01"), "2026-03-01", "Sunday is 7");
  const monthly: Schedule = { frequency: "MONTHLY", dayOfMonth: 1, asOfOffsetDays: 1 };
  assert.equal(scheduledAsOf(monthly, "2026-03-01"), "2026-02-28");
  assert.equal(scheduledAsOf(monthly, "2026-03-02"), null);
  assert.equal(scheduledAsOf(null, "2026-03-02"), null);
});
