# 0022 Roll-based strategy: Close-out+New

Status: proposed, for the owner's review. Completes the recorded gap "a roll-based strategy" (decision 0021 built Adjust+Swap). Source: the owner's file `Roll-based_decision_strategy.md`.

## Owner answers
The six defaults of decision 0021 were confirmed on 2026-11-20 (the recommendation ID is the roll ID; the maximum applies to the adjustment only in Adjust+Swap; close-outs at each maturing value date; `NO_TRADING_ENTITY`; a missing spot rate stops only the new trade; offsetting dates are closed with no roll). Close-out+New uses them wherever they apply.

## Decision
- **Policy.** `rollType` gains `CLOSE_OUT_NEW`. Everything else about roll dates is as in 0021: entered per cycle, the same window (near date to near plus offset), the same far date and offset defaults, the same refusals, the same gate and lock on Approve Exposure, the same `ROLL_DATES_NOT_SET` and `FAR_DATE_CLOSED`. `rollAdjustment` is not used and the recommendation's record shows none.
- **Close-outs.** The same as Adjust+Swap: the window's maturing hedges netted per value date and holding entity, each closed the other way at its own value date, booked by the entity that holds it.
- **New trades.** The window's hedges are treated as gone: the hedged amount the rule sees is the group's hedges minus what is maturing in the window. The ratio or amount-threshold rule, rounding and the minimum then give the new hedge exactly as for a plain recommendation, at the far date, booked by the group's entity (else the policy's). So when exposure and hedges are unchanged the new trade puts back what was closed plus any adjustment (the spec's "net exposure plus the closing trades"; it is the same as the gross-and-remaining-hedges form because the rules use the hedged amount).
- **Amount threshold.** Both strategies see the hedges that remain. The ratio rule gets the hedged amount without the maturing hedges; the amount-threshold rule gets the **net exposure after the close-outs** (gross plus the remaining hedges, that is the net minus what is maturing), for the inclusive comparison with the unrounded converted threshold and for the size and direction of the new trade. For example 1,000 EUR of exposure fully hedged by a sale maturing in the window nets to 0 now and +1,000 after the close-out: the package is a near buy closing the hedge and a new far sale of 1,000. Plain and Adjust+Swap threshold behavior are unchanged (review of PR 15).
- **Maximum.** The new trade is all new hedging, so the **maximum applies to it** and splits it into parts as before. (In Adjust+Swap the rolled amount is not subject to it.)
- **Parts.** Numbered close-outs by value date, then the new trades (role `NEW`, from the maximum's split), all linked by the recommendation ID. Accepting makes one single-leg pre-trade per part in one all-or-none FX Trade call. Close-outs without a new trade (the rule wants nothing more; `reason` says why, for example `WITHIN_TARGET`) and a new trade without close-outs (nothing matures) are both valid. The recommendation's amount, direction, value date and fixing date are those of the new trade.
- **Record.** Its hedged and needed amounts are those the rule used (after the close-outs); the close-outs are the parts. Roll type, near date, far date and offset are kept as made; the adjustment mode is empty.
- **Override.** Replaces the amount of the new trades, split as before; the close-outs do not move. With no new trade there is nothing to override ("there is no new trade to override"); it can be accepted or dismissed.
- **No change** to Exposure Analysis, FX Trade or Exposure Management.

## Defaults I chose (confirmed by the owner on 2026-11-20)
1. **The maximum applies to the new trade**, including the part of it that replaces what was closed (above). The alternative is to exempt an amount equal to what was closed, as Adjust+Swap does for the roll.
2. **The minimum applies to the whole new trade**, so a small adjustment on top of a large replacement is still traded; in Adjust+Swap the adjustment alone is tested.
3. **The recommendation shows the hedged amount after the close-outs**, not the hedges as they stood.
4. **The policy's `rollAdjustment` is ignored** for this type rather than refused.

## What changed
Migration `0013_close_out_new` (roll type and part role constraints). Contract: `CLOSE_OUT_NEW`, part role `NEW`, `RecommendationRoll.adjustment` may be null. Generation applies the rule to the remaining hedges and writes NEW parts; decide rewrites NEW parts on override; the roll-date command and the approval gate cover every rolling type.

## Tests
Close-outs plus one new trade and its pre-trades; nothing maturing; on target before (a new trade replaces the close-outs); close-outs only (no new trade, not overridable, accepted); a purchase when the target is lower; the minimum on the new trade; the maximum splitting only the new trade; override keeping the close-outs; each holder's close-out and the group's entity on the new trade; no entity; no dates; a closed far date; the approval gate; the ignored adjustment mode. The amount threshold on the net after the close-outs (equal to the threshold, just above it, and Adjust+Swap unchanged). Mutations (the original net passed, the post-close-out net used for Adjust+Swap too, its sign flipped, maturing not removed or added instead, wrong role, override writing adjustment parts, adjustment mode still applied, gate or dates command limited to Adjust+Swap, mode kept on the record) each fail a test.

## Not done, and why
- **A roll type per netting level, or per entity or region**: one roll type per program (decision 0020 leftover).
- **A screen for choosing the roll type or entering dates**: the commands exist; no UI.
