# Master Data

Tier: supporting.

## Owns
- Entities as a tree: type, country, parent, functional currency, treasury and hedge-execution flags
- Charts of accounts, the GL hierarchy and accounts, with statement type, normal balance and the monetary and FX-relevant flags
- Currencies, with whether each trades as an NDF (decision 0008), versioned like the rest
- The history of all of these: every version has a valid-from and valid-to
- Every change set received, and the safeguard that holds a snapshot ending too much
See docs/decisions/0004-master-data.md.

## Answers
- An entity or an account as of a date; the currencies on record and which are NDF
- Entities above or below an entity, as of a date
- The accounts on a hierarchy node and beneath it, as of a date
- Functional currencies of entities, as of a date
Each is defined in contract/.

## Announces
- Master data changed (one event per applied change set)
Events carry identifiers only.

## Consumes
- ERP and TMS syncs
- Manual uploads and edits

## Schema
`master_data`. Its tables are defined by this service's migrations.
