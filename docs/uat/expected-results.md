# Independent UAT expected results (E4)

Run `npm run uat:generate -- --seed 20261120 --out packs/uat/generated`, then `npm run uat:expected`. The latter reads the generated master data, daily GL and spot rates, each program's executed-trade history and `packs/uat/config.json`. It writes one `packs/uat/expected/<date>.csv` for each GL date, `expected-status.json`, and `gl-dirty-expected.json`. It imports `decimal.js` and no platform calculation code.

`gl-dirty-expected.json` independently sums every raw dirty-file balance by currency for the J1 batch control totals. It also classifies every row for each program into included, excluded and blocked, with row counts and balance sums by currency for each issue or exclusion reason. Compare the Data Source batch totals to `batchControlTotals`, its program totals to `byProgram`, and its blocked issue codes to `byReason`. Exclusion reasons are an independent file-and-mapping calculation; the Data Source contract does not report them separately.

The results are grouped by program, period and the program's netting level (entity for `BS-ENT`, region for `BS-REG`), currency pair and exposure currency. Columns carry gross, outstanding hedge and net amounts in each pair currency, exposure currency and USD display currency. A hedge-only group has zero gross. The stored amounts have two decimal places; shown amounts may later use zero places in a client.

## Rules used

| Rule | Source |
| --- | --- |
| Data Source mapping: only balances included by the configured program rules are eligible; excluded and blocked rows do not reach exposure | Decision 0006 and `docs/design/FX Exposure Platform — Data Ownership and Service Contracts.md` |
| Legal entity, monetary and FX-relevant account, non-functional currency filter; GL sign unchanged; period is as-of date | Decision 0008, points 2–4 |
| Market pair order: EUR, GBP, AUD, NZD, USD, CHF, CAD, SGD, then alphabetic; the other leg is opposite and rounded per row to two places, half away from zero | Decision 0008, points 5 and 14 |
| Same-day spot; direct USD pair, inverse or USD cross, rounded to ten places; missing rate makes the run wait | Decision 0005 and decision 0008, points 6 and 10 |
| Entity and region netting retain the pair and period; nearest REGION ancestor supplies region | Decision 0008, point 7 |
| Entity exposure currency is its non-functional leg. Region uses program override, then Master Data pair mapping, then the NDF/major-currency default | Decisions 0008 and 0015 |
| Display amount is currency 1 amount times the currency 1 to USD rate, rounded to two places | Decision 0008, point 8 |
| Live executed legs traded by the as-of date and maturing after it are outstanding. BUY adds the deal currency and subtracts settlement; SELL reverses it. Each leg is rounded to two places. | Decision 0010, points 1–5 |
| Gross plus outstanding hedges is net at the same complete group key. A hedge without its entity's functional currency uses the configured pair mapping or its deal currency. | Decision 0010, points 6–13, and decision 0015 |

The generated history has one leg per trade and no corrections. The calculator reads only that history. Simulated trades returned during rehearsal are checked separately after import, because they are created after these baseline expected CSVs.

On 2026-11-12 the EUR/USD spot and forward curve is deliberately absent. `2026-11-12.csv` therefore has the common header and no numeric rows; `expected-status.json` records `NO_RATE EUR-USD 2026-11-12`. Decision 0008 says the cycle stays initiated and waits for the missing rate. All other dates have numeric expected rows. These are independent predictions; comparison with a real Exposure Analysis run is part of E7 after D and J are available.
