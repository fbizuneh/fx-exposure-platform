# Hedge Recommendation

Tier: core.

## Owns
- Recommendations for a cycle: the calculation behind each, its parts when a maximum splits it, its decision (who, when, amount, note) and its follow-up status
- Its hedge policy per program: the strategy, amount threshold (override per netting level, decision 0020), target ratio (with pair overrides), minimum and maximum hedge amount in the display currency (the maximum with an override per netting level and a split method, decision 0016), rounding (with currency overrides), tenor, default trading entity
- Decisions, frozen at approval (undecided ones lapse)
- Reservations by an Approve Cycle in flight under segregation of duties (decision 0013)

## Answers
- The policy of a program, with defaults filled in
- A cycle's recommendations, including groups where no action was needed and why, and any currency whose business-day calendar was missing or too short for the dates
- One recommendation
- Who accepted or overrode a hedge on a cycle (dismissals excluded)
- Who has an Approve Cycle in flight on a cycle
Each is defined in contract/.

## Announces
- Recommendations issued (cycle and run)
- Pre-trade created (recommendation and pre-trade)
Events carry identifiers only.

## Consumes
- Net exposure of the finished run (Exposure Analysis)
- Pre-trade status, and creating pre-trades (FX Trade)
- Cycle and its approval state (Exposure Management)
- NDF currencies and business-day calendars (Master Data), and spot rates (FX Rate)
- Permissions (Identity)

## Strategy
`hedge-ratio-adjustment` (decision 0011): target hedge = ratio x gross exposure; recommend the gap to what is already hedged, rounded down to the step, if it reaches the minimum (converted to the exposure currency). More strategies are added beside it.
`amount-threshold` (decision 0020): when the net exposure (gross plus hedges) is at or above the threshold (display currency, converted at spot and compared unrounded; the level's own replaces the program's), the whole net is recommended; the strategy only decides the amount wanted. Rounding, the minimum and the split are shared by every strategy (`finishRecommendation`, `splitAmount`).

## Rules worth knowing
- A recommendation above the maximum is split into parts, evenly or as the maximum plus a remainder; accepting it makes one pre-trade per part, together (decision 0016).
- The app calls `onRunFinished` for each "run finished" event; a rerun replaces undecided recommendations and never doubles a group that has a decided one.
- `decide` (accept, override, dismiss) needs the matching `hedge-recommendation:*` permission. The first decision wins atomically; only a winning accept or override reaches FX Trade, from its recorded amount (decision 0011 item 11).
- The pre-trade is booked by the group's entity when the netting level has one, else the policy's default trading entity; with neither, no actionable recommendation.
- `onCycleClosed` lapses what is still open when a cycle is approved, skipped or deleted.
- `refreshFollowUp` follows the pre-trade's status. A split recommendation is executed, cancelled, closed out (every part executed or cancelled, some of each), partly executed or open (decision 0017).

## Schema
`hedge_recommendation`. Its tables are defined by this service's migrations.
