# 0011 Hedge Recommendation: hedge-ratio-adjustment

Date: 2026-11-20. Service: hedge-recommendation (core tier). Sources: The Core Flow (recommend, decide, follow up), decision 0009 (pre-trades), decision 0010 (net exposure), the product owner's answers of 2026-11-19. Written from those answers and my earlier plan; please check it against what you intended.

## Decided
1. **Strategy `hedge-ratio-adjustment`.** An incremental hedge toward a target ratio. Later strategies (a roll-based process with swap plus adjustment, and an amount threshold in place of a target ratio) are added beside it; each recommendation records its strategy.
2. **Calculation, per net exposure group of the run** (decision 0010): target hedge = minus ratio times gross exposure, in the exposure currency. Needed = target minus the outstanding hedges. The needed amount is rounded down (toward zero) to the rounding step, then tested against the minimum. A negative amount sells the exposure currency; a positive one buys it back (an over-hedge).
3. **Target ratio.** Default 100%, with an override per currency pair.
4. **Minimum hedge amount** is set once per program in the display currency. The application converts it to the exposure currency with the spot rate for the as-of date and tests the rounded recommended amount against it in the exposure currency. Below it, no action.
5. **Rounding.** A default (1,000 units of the exposure currency) with an override per exposure currency. 234,430 rounds down to 234,000 at 1,000.
6. **Groups with no action are kept** with the reason (within target, rounds to zero, below minimum, no rate) so the cycle record shows they were looked at.
7. **Instrument and legs.** A forward in the exposure currency (deal currency = exposure currency, settlement currency = the other currency of the pair); an NDF with a fixing date two weekdays before value when the exposure currency is flagged NDF in Master Data. The settlement amount is empty: a pre-trade has no price.
8. **Value date** = as-of date plus the policy tenor (default 1M), rolled forward to a weekday. Weekdays only for now: per-currency business-day calendars in Master Data are a follow-up.
9. **Policy** (per program): default ratio, ratio overrides by pair, minimum in display currency, rounding default and overrides by currency, tenor, and the trading entity. Changed with `hedge-policy:manage` on the program. With no policy saved the defaults above apply, and accepting is refused until a trading entity is set.
10. **Lifecycle.** A recommendation is open, then accepted, overridden (a user changes the amount, never the direction), dismissed, or lapsed. Undecided ones lapse when the cycle is approved. Decisions save who and when. Accept and override need `hedge-recommendation:accept` / `:override`, dismiss needs `:dismiss`, all on the program.
11. **Accept creates the pre-trade** in FX Trade at once (draft under the cycle, released by approval, decision 0009). If FX Trade refuses it, the decision is not recorded and the user sees why.
12. **Reruns.** A new run for the cycle replaces recommendations nobody decided. A group that already has a decided recommendation (same region, entity, pair and exposure currency) gets no new one, so a draft pre-trade is never doubled.
13. **Follow-up** follows the pre-trade: open (draft, ready, sent), partly executed, executed, cancelled. FX Trade's "executed trade received" event refreshes it.
14. **Events** (identifiers only): recommendations issued (cycle, run); pre-trade created (recommendation, pre-trade).

## Defaults I chose, to confirm or change
- The calculation uses gross exposure and outstanding hedges from decision 0010, so it never double counts a hedge.
- No maximum hedge amount yet.
- Segregation of duties (approver differs from the decider) is not enforced in this change; it needs an approval guard in Exposure Management and comes next.
- Business-day calendars are weekdays only until Master Data holds them.
