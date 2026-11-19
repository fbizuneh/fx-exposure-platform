# 0010 Net exposure: gross exposure plus outstanding hedges

Date: 2026-11-19. Service: exposure-analysis (amends 0008). Sources: Hedging Programs domain design (outstanding hedges, net exposure), decision 0009 (FX Trade).

## Decided
1. **Same sequence, no second calculation path.** Outstanding hedges run through the same netting as balances. Net exposure is gross exposure plus outstanding hedges at the same netting level.
2. **Which trades.** FX Trade's `executedTrades(program, asOf)`: live, current versions, traded on or before the as-of date. Each leg is used only if its value date is after the as-of date, so a swap's matured near leg drops out while its far leg stays.
3. **Hedge row.** One row per open leg. The pair comes from the deal and settlement currencies in market convention order; the legs are the deal and settlement amounts. Buying the deal currency is positive in it and negative in the settlement currency; selling is the reverse. Amounts are rounded to 2 places like balances. No aggregation before netting.
4. **Entity.** The trading entity must be on record in Master Data on the as-of date; its region comes from the same walk as for balances. A trade whose entity is unknown is counted and left out, not an error.
5. **Period** is the as-of date, as for balances in the daily program.
6. **Net group key = the level's region and entity dimensions + currency pair + exposure currency + period** (clarified by the product owner on PR #2). The same complete key aligns gross, hedges and net. Hedge amounts are net minus gross, so the three add up. A group may exist only because of a hedge (gross zero). Trades with the same full key net together.
7. **Per group the run saves** gross, hedges and net, each with currency 1 and 2 amounts, the exposure-currency amount and the display amount (currency 1 times the display rate, rounded to 2 places). The exposure currency is the same as for gross (decision 0008).
8. **Sign.** Positive is long. A hedge that offsets a long exposure is negative, so net is smaller.
9. **Rates.** The hedge pairs need display rates (and portfolio rates at that level) like any pair; a missing one makes the run wait, as before. No pair rate is needed for a hedge.
10. **Evidence.** The hedge rows are saved with the run with the executed trade ID, platform, trade ID and leg, so a hedge number traces to the trade version used. Counts of trades, open legs used, and left out are saved on the run.
11. **If FX Trade cannot be reached,** the run waits with that reason (the rule of decision 0008 that already covers any service).
12. **Exposure currency for hedges, chosen per row before aggregation, at entity-level netting.** If the trading entity's functional currency is one leg, the exposure currency is the other leg. If neither leg is the functional currency, it is the hedge's **deal currency**, not the program override or the default ranking. Acceptance case: for a USD-functional entity, an EUR/GBP hedge with EUR as deal currency and one with GBP as deal currency give **two** EUR/GBP rows, with exposure currency EUR and GBP. Other netting levels keep decision 0008's rules.

13. **Precision.** Gross, hedge and net amounts keep two decimals. The contractual hedge amount is never changed to make displayed totals reconcile; a one-unit difference when the UI shows zero decimals is accepted.

## Follow-up, not in this change
Client configuration mapping a currency pair to an exposure currency, so clients can align those rows on purpose. The existing override and default are not a substitute for the deal-currency rule here.

## Defaults I chose, to confirm or change
- Trades traded after the as-of date are not outstanding at that date, even if the run happens later.
- At netting levels that are not entity level, hedges use the existing exposure currency rules (the deal-currency rule is stated for entity level only).
- The question is `netExposures(runId)`; the existing `exposures` (gross) stays as it is.
