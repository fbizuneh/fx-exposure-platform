# 0008 Exposure Analysis: from included balances to gross exposure

Date: 2026-11-18. Service: exposure-analysis (core tier). Sources: the product owner's workbook (Exposure Calculation Steps) and the Hedging Programs domain design. Where they differ from earlier defaults, they win.

## Decided
1. **One sequence:** raw data, filter, normalize, baseline exposure, netting level, gross exposure, then (later) net exposure. This build covers GL balances; forecast and AR/AP adapters and outstanding hedges join later without a second calculation path. Net exposure (gross plus hedges) comes with FX Trade.
2. **Filter.** Only legal entities in force on the as-of date, and only accounts flagged both **FX-relevant and monetary**. Both flags come from Master Data as of the as-of date. Counts of what was set aside, and why, are kept with the run.
3. **Period.** For a GL balance the period is the **as-of date**.
4. **Sign.** The balance is used **exactly as the source sends it**. Nothing infers long or short from the account type, because a liability can arrive positive and an asset negative.
5. **Baseline.** Each filtered balance in a currency other than the entity's functional currency becomes one row: the natural pair is the transaction and functional currency, ordered by market convention (EUR, GBP, AUD, NZD, USD, CHF, CAD, SGD, then alphabetical; the earlier currency is currency 1). A balance in the functional currency is set aside (counted). The row has two legs of opposite sign: the transaction currency leg is the balance, the other is the balance converted at the pair rate and **rounded to 2 places per row**, so that drill-down rows add up to their group exactly.
6. **Rates.** Spot, as of the as-of date, from FX Rate (which already crosses through its base currency). Each rate used is saved with the run: pair, rate, quality, derivation, source and loads.
7. **Netting level** comes from the cycle's settings and is always by currency pair and period: group natural, group portfolio (every row re-expressed against the display currency, so an EUR-GBP row becomes an EUR-USD leg and a GBP-USD leg), region, region by legal entity, or legal entity. A legal entity's region is its nearest REGION ancestor in Master Data, or UNASSIGNED.
8. **Gross exposure** per netting group: currency 1 and currency 2 amounts (long, short and net on currency 1), the exposure currency amount, and the **display currency amount = currency 1 amount x rate(currency 1 to display currency)**, rounded to 2 places. Display currency is a program setting (default USD, decision 0007 widened here).
9. **Drill.** Group, then the baseline rows in it, each with its lineage back to the Data Source batch and record. The filtered transaction and the baseline are one row for a GL balance.
10. **A run waits, it does not fail.** The run starts from "cycle initiated". If there are no included balances for the program and date, or a pair rate is missing, the run is saved as WAITING with the reason, the cycle stays initiated, and nothing is announced. It is tried again when the tenant's data or rates change. Stale or outlier rates are used and shown as warnings.
11. **Run events.** Only when a run is complete does it announce "run started" then "run finished", both with the run ID (decision 0007). A rerun makes a new run and supersedes the old. A cycle's current run is frozen on "cycle approved" and never changes. Skipped or deleted cycles keep their runs as they were.
12. **Blocked balances do not stop a run.** The count of blocked balances across the tenant's current batches for that date is saved on the run, for display at approval.

## Defaults I chose, to confirm or change
- Display amount uses currency 1 as in the workbook, whatever the exposure currency is.
- Rounding is 2 places for every currency, half away from zero, as in the workbook.
- A zero balance is kept as a row.
- A run that can be tried again is retried by an explicit command, which the app calls on "batch stamped" and "rates loaded" events and on a timer.

## Amendments (2026-11-18, after the first build; not yet in code)
13. **Exposure currency** is set by a default logic and an override configuration. Default: if the pair has an NDF currency, that is the exposure currency; otherwise, if the pair has USD, the non-USD currency; then the same test for EUR, GBP, AUD, NZD, CAD, CHF, SGD in that order; otherwise currency 2. Users can override it per pair by configuration. This replaces the interim rule built in the first version (non-display currency, else currency 2).
14. **Rounding and display.** Amounts are rounded to 2 places (unchanged) and shown with 0 decimal places. This is a display rule; stored and returned amounts keep 2 places.

15. **NDF currencies are held in Master Data**, as a flag on its currency reference, effective-dated like the rest. Exposure Analysis asks Master Data which currencies are NDF on the as-of date.
16. **The override is per program** and is a program setting in Exposure Management (a pair, optionally with the exposure currency chosen), so it is copied into each cycle with the other settings.
17. **The override applies to the netted pair.** At the portfolio level the non-portfolio currency is always the exposure currency, and no override applies.

Build order for these: Master Data (NDF flag on currencies, question, change-set support), Exposure Management (override setting, migration, validation), then Exposure Analysis (the default logic and override in the run).

## Not built yet
Hedge rows and net exposure, forecast and AR/AP adapters, "entity by product, project or business unit" netting, per-pair exposure currency, purging of old runs.

## Revisit when
FX Trade supplies hedges, or a second source adapter needs a period other than the as-of date.
