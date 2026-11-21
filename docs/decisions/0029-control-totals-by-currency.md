# 0029 — Control totals by currency

Date: 2026-11-21. Service: data-source. Source: `docs/release-1/J-backend-gaps.md` (J1), confirmed as decision row #6 (Overview table) by Fikre on 2026-11-20.

## Decided

1. **A question, not a stored summary.** `controlTotals(tenantId, batchId)` groups `balances` by currency and outcome on read: one SQL query (`GROUP BY currency, outcome`), summed in `decimal.js` for the four currency-wide numbers (`receivedRows`/`receivedSum` plus `included`/`excluded`/`blocked`). No new table or migration.
   - **Measured, not assumed** (J1.3): against a 20,000-row, 40-currency batch on this machine's PostgreSQL 16, five repeated calls took 13–16 ms — well under the 500 ms budget in `docs/release-1/README.md`'s UAT size target. `received`/`included`/`excluded`/`blocked` numbers always add up by construction: `received` is literally the three outcome buckets added together, so there is nothing else to keep in step if a batch is reloaded or balances change shape later. A stored table would need to be written in the same transaction as every balance insert and would duplicate numbers that are cheap to recompute; at this cost there is no case for it.
2. **The no-currency bucket is `currency: ""`.** A row can reach intake with a blank currency (`GL_CURRENCY_MISSING`) or one intake could not parse at all; such a row is always `BLOCKED` (checkRow already requires a valid currency for `INCLUDED`/`EXCLUDED`). It still received a row, so it is counted under `""` rather than dropped from the totals. `expectedTotals` may use `""` the same way, though a sender is not expected to predict its own bad rows.
3. **A row whose amount could not be parsed contributes 0 to the sum, not an error.** The row is still BLOCKED (`GL_AMOUNT_INVALID`) and counted in `receivedRows`/`blockedRows`; its contribution to `receivedSum`/`blockedSum` is 0, since there is no signed number to add. This is the same `amount` value `intake.ts` already computed for the row (`checkRow`) — the control total does not recompute it.
4. **`expectedTotals` is compared inside the intake transaction, after per-row amounts are known but before the batch is written as `COMPLETED`.** A mismatch (a different sum, a different row count, or a currency present on only one side) writes the batch as `FAILED` — in the same transaction, so the attempt still shows up in `ingestionStatus` — and the call throws `BatchRefused` once that commits. Comparison is by decimal value (`"140.50"` equals `"140.5000"`), not by string, since the sender and Data Source need not share a formatting convention. The message lists every differing currency with both sides' numbers (`services/data-source/src/control-totals.ts`, `diffTotals`).
5. **Omitting `expectedTotals` changes nothing.** Existing callers of `submitGlBatch` are unaffected; the field is optional and the comparison is skipped entirely when absent.

## Cost
- `controlTotals` does one more query per call; at UAT size this is single-digit milliseconds, not worth caching.
- `expectedTotals`, when given, adds one `Map` pass over the batch's rows (already iterated once for validation) — no second iteration over the file.
- If a future program needs totals broken down further (e.g. by source system within a batch), that is a new question, not an extension of this one; `controlTotals` stays at the grain J1 asked for.

## Not done here
Nothing stores or exposes control totals across batches (e.g. a running total for a source system); D7 (the loader side, which hands `expectedTotals` to `submitGlBatch`) is a separate piece of work this hands over to.
