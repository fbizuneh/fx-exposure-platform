# FX Trade

Tier: supporting.

## Owns
- Pre-trades (draft, ready, sent, partly executed, executed, cancelled), numbered by part when a recommendation is split into several (decision 0016) and executed trades (append-only versions)
- The link between them, and the executed-trade files that were received, with their blocked rows
- Its part of a cycle's saved record, frozen at approval

## Answers
- Pre-trades by cycle, program and status
- Executed trades open on an as-of date, with deal and settlement amounts per leg
- Unmatched and ambiguous trades; blocked rows of a file
Each is defined in contract/.

## Announces
- Pre-trade ready to send
- Pre-trade cancelled (by a user, or when its cycle is closed before approval; once per pre-trade)
- Executed trade received (a new trade, a new version, or a match made by a user)
Events carry identifiers only.

## Consumes
- Pre-trades (Hedge Recommendation or manual entry)
- Executed trade files from outside (in demos, from the separate simulator tool, which is not part of this service)
- Trading entities and hedge execution flags (Master Data); program catalog and cycles (Exposure Management); permissions (Identity)
- Cycle approved (releases that cycle's drafts); cycle skipped or deleted (cancels them)

## Schema
`fx_trade`. Its tables are defined by this service's migrations.

Rules are in docs/decisions/0009-fx-trade.md.
