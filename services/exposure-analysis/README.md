# Exposure Analysis

Tier: core. Decision: `docs/decisions/0008-exposure-analysis.md`.

## Owns
- Runs: one per "cycle initiated" event, WAITING until everything is collected, then FINISHED; superseded by a rerun; frozen at approval
- Baseline rows (the filtered balances as two-legged currency-pair rows, with lineage) and gross exposure per netting group
- The rates used in a run, with their quality, and the filter counts and warnings of a run

## Answers
- The cycle's current run, and why a waiting run waits
- Gross exposure by netting level, currency pair and period, with display currency amount
- The baseline rows behind a group, with lineage to the Data Source batch and record
- The rates used
Each is defined in contract/.

## Announces
- Run started, then run finished, both with the run ID (decision 0007). Nothing is announced while a run waits.
Events carry identifiers only.

## Consumes
- Included balances and ingestion status (Data Source)
- Entities, accounts, regions and NDF currencies (Master Data)
- Spot rates (FX Rate)
- The cycle and its settings copy (Exposure Management)
- Later: pre-trades and executed trades (FX Trade), for outstanding hedges and net exposure

## How a run goes
Filter (legal entities; FX-relevant and monetary accounts; not in the functional currency) -> baseline (market-convention pair, two legs, per-row rounding) -> netting level (group natural or portfolio, region, region by entity, entity; always by pair and period) -> gross exposure. The app calls `onCycleInitiated` for each "cycle initiated" event, `retryWaiting` when a tenant's batches or rates arrive, and `onCycleApproved` on approval.

## Schema
`exposure_analysis`. Its tables are defined by this service's migrations.
