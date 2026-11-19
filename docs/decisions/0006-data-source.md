# 0006 Data Source: GL balances, one intake path, program stamping

Date: 2026-11-18. Service: data-source (supporting tier). Master Data's contract gains three batch questions (entities, accounts, hierarchy paths).

## Decided
1. **GL balances only in this build.** Every record carries a data type, so forecasts, orders and AR/AP can be added without reshaping it.
2. **One intake path.** A batch is the balances from one source system, for one chart and one as-of date. It is validated, stamped and stored in one transaction with its events. Each balance ends up INCLUDED (stamped with its program), EXCLUDED (out of scope, not an error) or BLOCKED (a data quality issue; it never reaches a run). The rest of the batch still goes through. A problem with the batch itself refuses the whole batch.
3. **The latest batch is the current one.** A later batch for the same source system and as-of date supersedes the earlier one, which is kept. Sending the current batch's content again changes nothing.
4. **Mapping rules carry over.** Include or exclude by account or by hierarchy node (the node and all below it), narrowed by source system, entity and named dimensions, with effective dates. An exclude removes accounts from the same program's includes. A balance claimed by two programs is blocked. A rule scoped to a source system is how a TMS balance can replace an ERP one.
5. **Rules refer to Master Data by code,** resolved as of the balance's date, so they survive a re-sync.
6. **Master Data is asked, never read.** Intake asks Master Data's contract for entities, accounts and hierarchy paths.
7. **Program catalog is a small reference copy,** set by command. The app will feed it from Exposure Management's events when that service exists.

## No source record ID
A GL balance from an ERP has none. A balance is identified by its data: **entity, account, currency and its dimension values.** Within a batch, rows with the same key are all blocked as duplicates, since there is no way to tell which is right. The key is also the record ID in the lineage reference (source system, batch, key).

## Defaults I chose, to confirm or change
- A balance is a signed amount as the source sends it, or separate debit and credit amounts (debit minus credit), never both. **The sign is kept exactly as received and carries no accounting meaning here**: a GL balance does not reliably show asset or liability (a liability account can be positive, an asset account negative), so nothing downstream infers long or short from the account type. Superseded wording "debit-positive" in the first draft; see decision 0008.
- Amounts are exact decimals, up to 4 places. Currency must be a valid 3-letter code.
- A row needs an entity, account, currency and amount. An unknown entity or account in Master Data, a missing or unsupported currency, a row whose as-of date differs from the batch, or a program that is unknown or disabled in the catalog blocks that balance.
- A batch with an unusable source system or date, no rows, a future date, or more than 20,000 rows is refused. Refusals with a usable source and date are recorded as FAILED.
- Rule dates are end-exclusive, like Master Data.
- Saving an include rule is refused if it would make two programs claim the same account on the same dates in the same scope. It is checked against Master Data as of the first day both rules apply, and accounts that any exclude rule of either program names are ignored. Intake is the last word: an overlap that gets past the check blocks the balance.
- Ingestion status is COMPLETED, COMPLETED_WITH_ISSUES or FAILED. There is no RECEIVED state, since a batch is processed in one step.
- Issues of a superseded batch are closed as RESOLVED, because the data they were about has been replaced.
- Two events: batch stamped, and issues raised (which covers blocked balances, since each is an issue).

## Not built yet
Waiving or assigning issues, forecasts, orders and AR/AP, connectors and file parsing, reconciliation to the source, and the screens.

## Revisit when
A data type other than GL balances is needed, or a source can supply a stable record ID.
