# 0017 Follow-up of a split recommendation: closed out when every part is finished

Status: accepted. Extends decision 0016 (the follow-up rule for a recommendation with several pre-trades).

## Decision (from the owner)
When every part of a split recommendation is finished, some executed and the rest cancelled, the recommendation is **closed out** with its own status, not left as partly executed. Option B of the question raised on PR #8.

## What it means
The follow-up of a whole recommendation, from its parts:
- every part executed: **EXECUTED**
- every part cancelled: **CANCELLED**
- every part finished (executed or cancelled), at least one of each: **EXECUTED_REST_CANCELLED** (new)
- a live part remains (open, or only partly filled) and one has been executed or partly filled: **PARTLY_EXECUTED**
- otherwise **OPEN** (or NOT_STARTED before the decision is confirmed)

The order does not matter: the status is recomputed from all parts each time one changes, so cancelling first and executing later gives the same result. A pre-trade that is only partly filled still counts as live.

## Defaults I took
- The status name is `EXECUTED_REST_CANCELLED`. It is a status of the whole recommendation only; a part is executed or cancelled, never both.
- A single-part recommendation behaves as before (executed or cancelled).
- Recommendations already in the database with this shape are moved to the new status by the migration.

## What changed
- Hedge Recommendation: `overallFollowUp` (the rule above), the `FollowUp` type in the contract, migration 0005 (the check on `recommendations.follow_up`, and the backfill).
- Tests: the rule, including a live part and a partly filled part keeping PARTLY_EXECUTED; an end-to-end case with one part executed and the rest cancelled.
