# 0016 Maximum hedge amount: splitting a larger recommendation

Status: accepted. Extends decision 0011 (item 4's minimum has a maximum beside it; "No maximum hedge amount yet" is resolved).

## Decisions (from the owner)
1. A **maximum hedge amount** is set in the program's hedge policy, **in the display currency**. A recommendation above it is split into n = roundup(amount / maximum) parts. Amounts are compared in display-currency equivalents (the maximum is turned into the exposure currency with the same spot rate as the minimum; the ratio is the same either way).
2. Two **split methods**: EVEN (450 at a maximum of 200: 150, 150, 150) and THRESHOLD_REMAINDER (200, 200, 50). Chosen **once per program** in the policy; an override changes the amount, not the method.
3. A **maximum override per netting level** (ENTITY, REGION, REGION_BY_ENTITY, GROUP_NATURAL, GROUP_PORTFOLIO) replaces the program's maximum for a cycle run at that level. Not per entity or region.
4. **One recommendation, several pre-trades.** The recommendation is decided once (accept, override, dismiss); accepting it makes one pre-trade per part.
5. With THRESHOLD_REMAINDER, a **last part below the minimum is added to the part before it** (so that part exceeds the maximum, and the recommendation records why).

## Defaults I took
- The minimum and maximum are both tested in the exposure currency; the minimum still applies to the whole recommendation as before.
- Parts are whole rounding steps when the amount is. EVEN gives the leftover steps to the first parts; THRESHOLD uses the maximum rounded down to a step. An override amount that is not a step multiple is split in units of 0.0001.
- EVEN with parts below the minimum uses one part fewer, repeatedly, until none is (the parts then exceed the maximum; a note says so).
- At most **50 parts**; beyond that the amount is split evenly into 50 and a note says the parts exceed the maximum.
- A policy is refused if a maximum (the program's or an override) is below the minimum, or is not above 0. No maximum is the default.
- A group whose maximum cannot be converted for lack of a spot rate has no action (`NO_RATE`), as for the minimum.
- All parts share the instrument, trading entity, value date and fixing date.
- **An override** of the amount is split the same way (same maximum, method and minimum), and an override above the maximum is allowed: it is a user's decision and is recorded.
- The pre-trades of one decision are made in **one call to FX Trade**, which makes all of them or none. If FX Trade refuses, the recommendation reopens with its original parts. If the answer is lost, FX Trade is asked what it holds: every part means confirm, none means retry or lapse at cycle approval.
- **Follow-up of the whole**: executed when every part is; partly executed once any part is executed or partly executed (a cancelled part does not make the rest less done); cancelled when every part is; otherwise open.

## What changed
- Hedge Recommendation: policy fields `maxHedgeDisplay`, `maxHedgeOverrides`, `splitMethod`; `recommendation_parts` (amount, pre-trade, follow-up per part); the recommendation records the maximum, method and any split note. `pre-trade-created` is one event per part (with `partNo`). `Recommendation.parts` is new; `preTradeId` is the first part's.
- FX Trade: a pre-trade made for a recommendation has a **part number** (unique per recommendation); `createPreTrades` items take `partNo` (default 1), so callers that do not split are unchanged.

## Review fixes (PR #8)
- **Split invariants.** After rounding, every part is positive, there are at most 50, and the parts add up exactly to the amount. A step too coarse for the maximum (1,000 at maximum 400, step 1,000) gives fewer, larger parts instead of zero-amount parts; a split that would exceed 50 parts is re-split evenly into the most allowed. The split note says when parts exceed the maximum and why. A violation throws rather than persists.
- **The note follows the parts.** An override re-splits the amount and saves the new note with the new parts; if FX Trade refuses, the original parts and the original note are both restored.
- **Cancellation reaches the recommendation.** FX Trade announces `fx-trade.pre-trade-cancelled` once per pre-trade (user cancellation, or cycle closure before approval). Hedge Recommendation refreshes the follow-up from FX Trade's current state, so redelivery is harmless. One cancelled part leaves the whole OPEN; every part cancelled makes it CANCELLED; if any part executed, the whole stays PARTLY_EXECUTED (cancelled parts do not reduce it).
- **The cap is applied before allocating.** The number of parts (including whether a small remainder would be merged) is counted first; above the cap the split goes straight to the bounded even fallback, so an enormous amount-to-maximum ratio never builds the uncapped list.
- **A cancellation that arrives before the link is not lost.** FX Trade can commit the drafts, and one can be cancelled, before the recommendation records which pre-trade is which part; the event then finds nothing to update. After confirming, the recommendation reads each part's current state from FX Trade and brings its follow-up up to date, with no transaction across the two services. That immediate read is best effort (a failure does not make the committed decision look failed); the `pre-trade-created` event is also routed to the dispatcher, which refreshes the part and leaves the event pending until the read succeeds, so a transient failure is repaired on a later drain without a second pre-trade or decision record.

## Not built
A maximum per entity or region; a maximum by currency pair; spreading parts over different value dates; capping an override at the maximum.
