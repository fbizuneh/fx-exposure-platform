# Data Source

Tier: supporting.

## Owns
- Program mapping rules, and each included balance's program memberships (up to two balance sheet programs may share a source row; decision 0027)
- Ingested GL balances with their lineage (source system, batch, and the balance's key), and every batch received
- Ingestion status and data quality issues
- A small reference copy of the program catalog
See docs/decisions/0006-data-source.md and 0027-two-balance-sheet-programs.md.

## Answers
- Included balances for a program, as-of date and scope (current batches only)
- Ingestion status
- Data quality issues
Each is defined in contract/.

## Announces
- Batch stamped
- Issues raised (this covers a blocked balance, since each is an issue)
Events carry identifiers only.

## Consumes
- Batches from source systems (sent by connectors, files or manual entry)
- Entities, accounts and hierarchy paths (Master Data's contract)
- Program catalog (Exposure Management)

## Schema
`data_source`. Its tables are defined by this service's migrations.
