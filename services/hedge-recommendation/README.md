# Hedge Recommendation

Tier: core.

## Owns
- Recommendations for a cycle: the calculation behind each, its decision (who, when, amount, note) and its follow-up status
- Its hedge policy per program: target ratio (with pair overrides), minimum hedge amount in the display currency, rounding (with currency overrides), tenor, default trading entity
- Decisions, frozen at approval (undecided ones lapse)

## Answers
- The policy of a program, with defaults filled in
- A cycle's recommendations, including groups where no action was needed and why
- One recommendation
- Who accepted or overrode a hedge on a cycle (dismissals excluded)
Each is defined in contract/.

## Announces
- Recommendations issued (cycle and run)
- Pre-trade created (recommendation and pre-trade)
Events carry identifiers only.

## Consumes
- Net exposure of the finished run (Exposure Analysis)
- Pre-trade status, and creating pre-trades (FX Trade)
- Cycle and its approval state (Exposure Management)
- NDF currencies (Master Data) and spot rates (FX Rate)
- Permissions (Identity)

## Strategy
`hedge-ratio-adjustment` (decision 0011): target hedge = ratio x gross exposure; recommend the gap to what is already hedged, rounded down to the step, if it reaches the minimum (converted to the exposure currency). More strategies are added beside it.

## Rules worth knowing
- The app calls `onRunFinished` for each "run finished" event; a rerun replaces undecided recommendations and never doubles a group that has a decided one.
- `decide` (accept, override, dismiss) needs the matching `hedge-recommendation:*` permission. The first decision wins atomically; only a winning accept or override reaches FX Trade, from its recorded amount (decision 0011 item 11).
- The pre-trade is booked by the group's entity when the netting level has one, else the policy's default trading entity; with neither, no actionable recommendation.
- `onCycleClosed` lapses what is still open when a cycle is approved, skipped or deleted.
- `refreshFollowUp` follows the pre-trade's status.

## Schema
`hedge_recommendation`. Its tables are defined by this service's migrations.
