# Exposure Analysis

Tier: core.

## Owns
- Exposures by program, cycle, date bucket and currency pair, with lineage
- The rates used in a run, and the evidence of the run
- Its part of a cycle's saved record, frozen at approval

## Answers
- Exposure by program, cycle, date bucket and currency pair, with lineage
- The evidence of a run
Each is defined in contract/.

## Announces
- Run finished
Events carry identifiers only.

## Consumes
- Included balances (Data Source)
- Pre-trades and executed trades (FX Trade)
- Rates (FX Rate)
- Functional currencies (Master Data)
- Settings (Exposure Management)

## Schema
`exposure_analysis`. Its tables are defined by this service's migrations.
