# FX Rate

Tier: supporting.

## Owns
- Rates by pair, date and tenor

## Answers
- The rate for a pair, date and tenor
Each is defined in contract/.

## Announces
- Rates loaded for a date
Events carry identifiers only.

## Consumes
- Rate providers

## Schema
`fx_rate`. Its tables are defined by this service's migrations.
