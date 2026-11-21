# Data Source

Tier: supporting.

## Owns
- Program mapping rules, and the program ID stamped on each balance
- Ingested GL balances with their lineage (source system, batch, and the balance's key), and every batch received
- Ingestion status and data quality issues
- A small reference copy of the program catalog
See docs/decisions/0006-data-source.md.

## Answers
- Included balances for a program, as-of date and scope (current batches only)
- Ingestion status
- Data quality issues
Each is defined in contract/.

## Announces
- Batch stamped
- Issues raised (this covers a blocked balance, since each is an issue)
- Change records for Audit, when a person (not a connector feed) loads a batch or adds or ends a mapping
  rule (decision 0012/0032): `batch.loaded`, `mapping-rule.added`, `mapping-rule.ended`
Events carry identifiers only.

## Consumes
- Batches from source systems (sent by connectors, files or manual entry)
- Entities, accounts and hierarchy paths (Master Data's contract)
- Program catalog (Exposure Management)

## Files
`parseGlFile` in `src/file.ts` reads GL CSVs (layouts in `docs/file-layouts.md`) via the local `csv.ts`. Shape only; further columns become dimensions.

Currency codes are the ISO list plus a short set of deliberate exceptions, today `CNH` (decision 0028).

## Schema
`data_source`. Its tables are defined by this service's migrations.
