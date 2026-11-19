# Data Source

Tier: supporting.

## Owns
- Program mapping rules, and the program ID stamped on each balance
- Ingested balances with their lineage
- Ingestion status and data quality issues
- A small reference copy of the program catalog

## Answers
- Included balances for a program, as-of date and scope
- Ingestion status
- Data quality issues
Each is defined in contract/.

## Announces
- Data arrived and stamped
- Balance blocked
- Data quality issue raised
Events carry identifiers only.

## Consumes
- Files and feeds from source systems
- Entities, accounts and hierarchy (Master Data)
- Program catalog (Exposure Management)

## Schema
`data_source`. Its tables are defined by this service's migrations.
