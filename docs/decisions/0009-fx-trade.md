# 0009 FX Trade: pre-trades out, executed trades in

Date: 2026-11-19. Service: fx-trade (supporting tier). Sources: The Core Flow (trade section), Hedging Programs domain design (execution, hedge trade file, NDF and swap notes).

## Decided
1. **Two record types.** A pre-trade is a request with a status (draft, ready, sent, partly executed, executed, cancelled). An executed trade is a fact and is append-only; a change is a new version and a cancel is a new version marked cancelled. A match is a link from an executed trade to a pre-trade.
2. **Instruments:** spot, forward, NDF and swap. Every trade has legs. A spot, forward or NDF has one leg; a swap has a near leg and a far leg in one trade. An NDF needs a settlement currency and a fixing date.
3. **Direction** is buy or sell of the deal currency; the settlement currency is the other side. Amounts are positive decimals with up to 4 places.
4. **Executed-trade file:** the standard flat file (trade ID, trading entity, counterparty, trade date, value date, deal and settlement currency and amount, fixing date, instrument, buy or sell, execution platform ID, portfolio, hedging program ID, custom fields), plus optional `pre_trade_reference` and `leg` (a swap arrives as two rows with the same trade ID, NEAR and FAR). The key is platform + trade ID. The same file twice changes nothing. A changed row for a known key is stored as a new version and the old one stays. Bad rows are blocked as issues with the raw row kept; the rest of the file is stored.
5. **Validation:** trading entity must exist in Master Data on the trade date and be flagged hedge execution entity; currencies are three letters and differ; settlement amount is required on an executed trade; dates are real.
6. **A trade with no program, or a program not in the catalog, is stored unmatched** (program empty) and shown to a user. It is never dropped.
7. **Matching, in order.** (a) By the pre-trade reference echoed in the file. It must fit: same program, entity, instrument, direction, currencies and value dates, and an amount not above what is still open. (b) With no reference: exactly one open pre-trade of the same program, entity, instrument, direction, currency pair and value dates, with room for the amount. No tolerance: dates and currencies match exactly. Zero fits is unmatched, several fit is ambiguous; both are stored with the candidates and shown to a user. Several executed trades may fill one pre-trade (partly executed, then executed). A swap fills whole, never in parts.
8. **Release gate.** Pre-trades made from a recommendation are drafts under the cycle ID. Cycle approved makes them ready and announces each. A manual pre-trade belongs to a program, needs `fx-trade:manage`, and is released by a user action.
9. **Sending out** is a file in the same flat-file shape. Exporting moves ready pre-trades to sent. No connectors in this build; the separate simulator reads the file.
10. **What others see.** Questions: pre-trades (by cycle, program, status), executed trades open on an as-of date (trade date on or before it, last value date after it; legs with deal and settlement amounts), unmatched trades, batch issues. Commands: create pre-trades (Hedge Recommendation, idempotent by recommendation ID), manual pre-trade, release, cancel, export, import, cancel executed trade. Events (identifiers only): pre-trade ready to send; executed trade received.
11. **Trade reference (confirmed 2026-11-19).** Every pre-trade gets its own unique reference, `PT-` plus 12 characters, unique within the tenant. It is a column of the outbound file, and the execution platform echoes it in `pre_trade_reference` on the executed trade. It is the first and main way an executed trade is matched; characteristics are only the fallback when a trade comes back without one.
12. **Executed trades never change a saved cycle.** They arrive after approval and attach to the program; the cycle's saved record is not touched.

## Defaults I chose, to confirm or change
- Matching is exact (no tolerance on amount or dates beyond "amount not above what is open").
- An amended executed trade keeps its link to the pre-trade; fill totals are recomputed from current, live versions.
- Importing executed trades needs no user permission (a connector or the simulator calls it, as with Data Source); user commands do.
- Out of scope: roll or swap recommendation, FX-impact revaluation, fixing-rate import, platform connectors, hedge rows in Exposure Analysis (the next step).
