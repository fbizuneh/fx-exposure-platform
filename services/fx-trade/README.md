# FX Trade

Tier: supporting.

## Owns
- Pre-trades and executed trades
- Its part of a cycle's saved record, frozen at approval

## Answers
- Pre-trades and executed trades by program, entity and period
Each is defined in contract/.

## Announces
- Pre-trade ready to send
- Executed trade received
Events carry identifiers only.

## Consumes
- Pre-trades (Hedge Recommendation or manual entry)
- Executed trade files from outside (in demos, from the separate simulator tool, which is not part of this service)
- Entity mapping (Master Data)

## Schema
`fx_trade`. Its tables are defined by this service's migrations.
