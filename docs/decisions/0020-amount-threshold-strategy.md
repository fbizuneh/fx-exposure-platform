# 0020 Amount-threshold strategy

Status: proposed, for the owner's review. Resolves the recorded gap "amount-threshold strategy" (decision 0011 item 1). Owner instruction: a default threshold per program in the display currency, overrides by netting dimension, hedge the full net when it is larger, then the same rounding, minimum and maximum/split; and keep those shared across threshold types. Owner answer: overrides by **netting level only**.

## Decision
- **Strategy.** A program's policy has a `strategy`: `hedge-ratio-adjustment` (the default, as before) or `amount-threshold`. One per program. Each recommendation records the strategy that made it.
- **Threshold.** `amountThresholdDisplay`, in the display currency and above 0, plus `amountThresholdOverrides`: one per netting level, replacing the program's for groups at that level (the same shape as the maximum, decision 0016). The amount-threshold strategy needs the program threshold; the database refuses a policy that uses the strategy without one.
- **The rule.** The threshold is turned into the exposure currency at the spot rate (as the minimum and maximum are). The **net exposure** (gross plus outstanding hedges, in the exposure currency) is compared with it: larger, either way, means hedge **all of the net** (a long net is sold, a short net bought), which brings the net to zero; equal or smaller means no recommendation (`WITHIN_THRESHOLD`). Without the rate the threshold cannot be compared, and the group is `NO_RATE`.
- **Shared rules.** The strategy only says what amount it wants (`ratioAdjustmentNeed`, `amountThresholdNeed`). One function, `finishRecommendation`, then rounds it down to the step, tests the minimum and picks the direction; `splitAmount` splits an amount above the maximum. A later strategy (value at risk) adds its own need function and reuses both. The ratio strategy's results are unchanged (its existing tests pass untouched).
- **What a recommendation shows.** For this strategy `ratio` is empty (it has none) and `thresholdExposureAmount` holds the threshold it was compared with; the target is what is hedged plus the whole net, and the needed amount is minus the net. For the ratio strategy the threshold field is empty.

## What changed
Migration `0008_amount_threshold`: `strategy` and `amount_threshold_display` on the policy, the override table (with a key to its policy that carries the program, decision 0018), `ratio` allowed empty and `threshold_exposure_amount` on recommendations. The contract gains the policy fields, `WITHIN_THRESHOLD`, the `amount-threshold` strategy and the two recommendation fields (`ratio` may now be null).

## Tests
Pure: the rule both ways, equal to the threshold, a hedge already in place, no rate, and the shared rounding and minimum giving the same result for both strategies; policy checks. Database: hedged in full with the threshold shown, equal to the threshold within and a cent above not, the level override against the program default and another level ignored, rounding, minimum and both splits applied to this strategy, accepting it makes the pre-trade, read-back, a policy without a threshold refused and the database constraint, and a cycle recalculated after an executed hedge deciding on the net rather than the gross. Mutations (`<=` to `<`, no level override, no rounding, wrong sign, gross for net) each fail a test.

## Not done, and why (for you to decide)
- **A threshold below the minimum hedge amount** is allowed; the minimum then decides (a net above the threshold but below the minimum is `BELOW_MINIMUM`). Refusing it, as the maximum is refused below the minimum, is a one-line change if you prefer.
- **Hedging only the excess over the threshold** (net minus threshold) rather than the full net. You asked for the full net, so that is what it does.
- **Overrides by pair, entity or region**: not built (answer above).
- **A different strategy per netting level** in one program: not built; one strategy per program.
- **A screen or API for choosing the strategy**: the policy is saved through the existing command; no UI exists yet.
