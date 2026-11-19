# Master Data

Tier: supporting.

## Owns
- Entities, accounts and the hierarchy, effective-dated
- TMS accounts
- Functional currencies

## Answers
- Entities, accounts and hierarchy walks as of a date
- TMS accounts
Each is defined in contract/.

## Announces
- Master data changed
Events carry identifiers only.

## Consumes
- ERP and TMS syncs
- Manual uploads

## Schema
`master_data`. Its tables are defined by this service's migrations.
