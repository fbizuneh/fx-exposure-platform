# Hedge Recommendation

Tier: core.

## Owns
- Recommendations for a cycle and their follow-up status
- Its hedge policy
- Decisions, frozen at approval

## Answers
- Recommendations for a cycle and their follow-up status
- Its hedge policy
Each is defined in contract/.

## Announces
- Recommendation issued
- Pre-trade created
Events carry identifiers only.

## Consumes
- Exposure (Exposure Analysis)
- Executed trades (FX Trade)
- Settings (Exposure Management)

## Schema
`hedge_recommendation`. Its tables are defined by this service's migrations.
