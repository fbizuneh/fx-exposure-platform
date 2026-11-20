# 0021 Roll-based strategy: Adjust+Swap

Status: proposed, for the owner's review. Resolves part of the recorded gap "a roll-based strategy" (decision 0011 item 1; decision 0009 listed "roll or swap recommendation" as out of scope). Source: the owner's file `Roll-based_decision_strategy.md`. This record covers **Adjust+Swap** only; **Close-out+New** is the next change.

## Owner answers (asked in chat)
1. **Roll inputs** (near date, far date, offset) are **entered per cycle**. The far date defaults to the policy's tenor date (with calendars) and the offset to a policy default. They live in Hedge Recommendation; Exposure Management is unchanged.
2. **Several maturing value dates**: separate single-leg forwards (or NDFs) **tied together**, not an instrument SWAP. One close-out per value date and one far trade. FX Trade's swap shape is unchanged.
3. **Scope**: Adjust+Swap first.
4. **Window**: from the near date to the near date plus the offset. (The file says "far leg to far leg plus offset" once; the owner confirmed it is the near leg.)
5. **Deciding**: the trades are accepted or dismissed **as one package**. An override changes only the adjustment amount (the combined far trade when they are booked as one); the close-outs and the rolled amount are what is maturing.
6. **No roll dates for a cycle**: no action, with a reason. Every group is `NONE` with `ROLL_DATES_NOT_SET`.

## Decision
- **Policy.** `rollType` (`NONE` default, or `ADJUST_SWAP`) sits beside the strategy: the ratio or amount-threshold rule still decides the adjustment, and the roll is added to it. `rollAdjustment` is `SEPARATE` (default: close-outs, the roll and the adjustment are separate trades) or `COMBINED` (the roll and the adjustment are one trade at the far date, as the file's two-trade form). `rollOffsetDays` (default 0) is the offset used when a cycle gives none.
- **Roll dates.** `setRollDates` (permission `hedge-policy:manage`) enters near date, optional far date and optional offset for a cycle. It is allowed only while the program rolls and before the exposure is approved; the near date must be after the as-of date and the far date after near plus offset. The user then reruns the cycle. A change goes to the audit trail. A group whose far date (entered, or the policy's tenor date) is not after the window gets `ROLL_DATES_NOT_SET` too, so a roll never ends before it starts.
- **What matures.** Exposure Analysis now keeps, on each hedge row, its value date, the net group it fell in and its amount in that group's exposure currency (migration 0007; rows of earlier runs have none and are ignored). Hedge Recommendation takes each group's legs with a value date from the near date to near plus offset, both included.
- **The trades.** Legs are netted by value date (signed; a hedge against a long exposure is negative). Each date that nets to something gets a **close-out** at that date in the opposite direction (a sold hedge is closed by buying). The **roll** puts back the total at the far date, in the hedges' direction. The **adjustment** is the existing rule's amount at the far date. Nothing maturing gives the plain adjustment at the far date; no adjustment gives the roll trades only (`reason` says why, for example `WITHIN_TARGET`); dates that offset each other are closed with no roll. Rounding, the minimum and the maximum/split apply to the adjustment only; the close-outs and the roll are exact.
- **One far trade.** In `COMBINED` the far trade is the signed sum of roll and adjustment: smaller or larger the other way it shrinks or flips, and exactly offsetting means no far trade, only close-outs. It is not split by the maximum.
- **Parts.** One recommendation per group, as before. Its parts are numbered close-outs (by value date), roll, then adjustment parts, and carry a `role`. Close-outs and the roll carry their own direction, value date and fixing date; the recommendation's direction, amount, value date and fixing date are those of the adjustment (of the combined trade). NDF fixing dates use the existing calendar rule. Accepting makes one pre-trade per part in one all-or-none FX Trade call, as for a split; the **recommendation ID is the roll ID** that ties them.
- **Override.** Replaces only the adjustment (or the combined trade) and is split as before; the other parts are kept. A recommendation with no adjustment cannot be overridden (`there is no adjustment to override`); it can be accepted or dismissed.
- **Record.** A rolled recommendation keeps its roll type, mode, near date, far date and offset as they were when it was made.

## Defaults I chose, to confirm or change
1. **The recommendation ID is the roll ID**, so FX Trade gets no new column (the earlier plan was a `roll_group_id`). The link already exists, is made together and is read back by FX Trade. Change it if you want a roll ID that groups several recommendations, which is not needed while a roll is one group.
2. **The maximum hedge applies to the adjustment only**, and not at all when roll and adjustment are one trade. The roll is existing hedge, not new.
3. **Close-outs are booked at each maturing value date** and the far legs at the far date entered. The far date is not moved to a business day; a defaulted one is rolled modified following as the tenor date is.
4. **A group with no trading entity** (at levels without an entity, no default entity in the policy) gets `NO_TRADING_ENTITY` for the whole package.
5. **Missing spot rate** (needed for the minimum, maximum or threshold) stops only the adjustment (`NO_RATE`); the roll trades need no rate and are still made.
6. **Offsetting dates** (one date sold, another bought) are closed and nothing is rolled.

## What changed
Exposure Analysis: migration `0007_hedge_row_placement`, `hedgeRowPlacement`, and `HedgeRow` in the contract gains `valueDate`, `groupNo`, `exposureAmount`. Hedge Recommendation: migration `0009_roll_strategy` (policy columns, `roll_parameters`, roll fields on recommendations, `role`/`direction`/`value_date`/`fixing_date` on parts); `planRoll` and `combineRoll`; generation, decision and restore by role; `setRollDates`; the contract gains the policy fields, `ROLL_DATES_NOT_SET`, `PartRole`, `RollParameters`, `RecommendationRoll`, the part fields and the `rollParameters` question.

## Tests
Pure: the window (both ends, offset 0), netting by date, direction, offsetting dates, nothing maturing, combined sums (same side, smaller, exact, flipped), date and policy checks. Exposure Analysis: each leg's value date, group and amount, adding up to the group's hedge. End to end: no dates; separate trades from accept to pre-trades; override changing only the adjustment, with a split after the roll; combined (shrunk, removed, flipped, overridden); roll only (accepted, dismissed, not overridable); empty window, tenor default and a tenor inside the window; refusals (no roll, too early, after exposure approval). Mutations (window end exclusive, close-out direction, combined sign, override rewriting every part, missing dates treated as an adjustment, close-outs at the far date, split in combined mode, placement in the wrong currency or group) each fail a test.

## Not done, and why
- **Close-out+New**: next change.
- **A screen or API for entering roll dates or choosing the roll type**: the commands exist; no UI.
- **Per-group or per-level roll dates, or a roll type per netting level**: one set per cycle and one roll type per program.
- **Rolling executed legs that are partly matched or cancelled**: Exposure Analysis already counts only live open legs.
