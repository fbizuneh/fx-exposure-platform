# FX Rate

Tier: supporting.

## Owns
- Rates by tenant, source, pair, business date and tenor (spot and forward)
- The record of every load, with its quality flags
- Each tenant's preferred source, pivot currency and outlier and staleness settings
See docs/decisions/0005-fx-rate.md.

## Answers
- The rate for a pair, date and tenor, direct, inverted, crossed through a pivot, or identity
Each is defined in contract/.

## Announces
- Rates loaded for a date (one event per accepted load)
Events carry identifiers only.

## Consumes
- Rate providers (loads sent by connectors, files or manual entry)

## Files
`parseRatesFile` in `src/file.ts` reads rate CSVs (layouts in `docs/file-layouts.md`) via the local `csv.ts`. Shape only; money stays text.

## Schema
`fx_rate`. Its tables are defined by this service's migrations.
