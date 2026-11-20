# J. Backend gaps

## Purpose

Three gaps recorded in `docs/STATUS.md` must close before UAT: control totals by currency, audit records for Data Source and Exposure Analysis, and a safe way to see and retry stuck events. All three are backend only: functions, questions and records. The screens come later with B and F.

**Needs nothing first. Runs in parallel with A, D and E. J1 hands a new field to D (step D7).**

## Read first

- `docs/STATUS.md` (the "not built" paragraph), `docs/decisions/0012-audit.md`, `docs/decisions/0019-delivery-retry.md`.
- `services/data-source/src/intake.ts` (`GlBatch`, `BatchResult`, how a row's signed amount is worked out, how batches are stored) and `queries.ts`.
- Audit's contract (`ChangeRecordFields`) and how Master Data and FX Rate announce change records (search for `change-recorded`).
- `services/identity/contract` and `src/` for permissions, roles and `checkAccess`.
- `app/src/dispatch.ts` (`deliveryProblems`, `retryStuckEvent`).
- `app/src/runtime.ts` and `app/README.md` (stream A, built): `/status` reports counts of events waiting or stuck, and J3's summary function can feed it.

## Decisions this task relies on

Overview table (README) **#6** (control totals), **#7** (audit coverage), **#8** (stuck-event permission). Each task below stops at DECISION REQUIRED if Fikre has not confirmed its row.

## J1. Control totals by currency

A control total is how a receiver proves it got what the sender sent. Data Source owns batches, so it owns this.

1. **A question** `controlTotals(tenant, batchId)` in Data Source's contract. For each currency in the batch it returns: rows received, sum of signed amounts received, and the same two numbers for rows included, excluded and blocked. The signed amount is the one Data Source already works out for a row (`balance`, or debit minus credit). Read how `intake.ts` does it and reuse that value; do not compute it a second way. Sums are `decimal.js` strings. A batch that does not exist, or belongs to another tenant, is an error naming neither.
2. **An optional field** `expectedTotals?: { currency: string; rowCount: number; sum: string }[]` on `GlBatch`. When it is given, Data Source compares it with the received totals inside the intake transaction. Any difference, a currency missing on either side, or a different row count refuses the batch: store it as a FAILED batch (as other refusals are) with a message that lists each differing currency and both numbers. When it is not given, intake behaves exactly as today.
3. If computing the totals on read is too slow at 20,000 rows and 40 currencies, store them at intake in a table in Data Source's schema (a migration in that service). Decide by measuring: the question must answer in under 500 ms for a 20,000-row batch. Record the measurement.

Done when: tests show totals add up to the batch (sum of the groups equals the whole), a duplicate batch returns the same totals, a matching `expectedTotals` is accepted, each kind of difference is refused and stored as FAILED, and a batch with no `expectedTotals` is unchanged. Break each rule and watch a test fail. Tell the owner of stream D when merged so D7 can start.

## J2. Audit records for Data Source and Exposure Analysis

Follow decision 0012 exactly: a governed change is announced as a `<service>.change-recorded` event with `ChangeRecordFields`, in the **same transaction** as the change. The record holds identifiers, an action and the names of changed fields. **No values.**

**Data Source.** Record, when the actor is a person (follow the same test Master Data and FX Rate use to tell a person's `user:` or `platform:` actor from a connector):

| Action | Target | Fields |
| --- | --- | --- |
| `batch.loaded` | the batch ID | none |
| `mapping-rule.added` | the rule ID | none |
| `mapping-rule.ended` | the rule ID | `validTo` |

`endMappingRule(tenant, ruleId, endsOn)` has no `by` today, and a record needs one: add it (as decision 0012 did for `setProgramRestriction`), and update every caller. A batch from a connector is a routine feed and is not recorded. A repeat that changes nothing (a duplicate batch) records nothing.

**Exposure Analysis.** List every command a person can call in its contract and code. For each, decide if it changes what the next run shows (a manual override, a resolution of a data issue, a setting). Record those with the same shape. Runs started by the platform stay unrecorded (decision 0012). **If Exposure Analysis has no person-triggered command, record nothing, say so in the decision record, and tell Fikre** rather than inventing records.

**Found along the way.** The rate settings (`setStaleAfter`, `setPreferredSource`, `setPivotCurrency`, `setOutlierShare`) and Master Data's `setMaxEndShare` have no actor and are not recorded. They change what exposures are computed from. Do **not** add them in this task; list them in the PR description for Fikre to decide.

Done when: tests, after a `drain`, show each recorded action in Audit's trail for the right tenant and program; `verify` of the hash chain still passes; a connector load and a duplicate load record nothing; delivering the same announcement twice records once. Break the same-transaction rule (announce after commit) in a test double and watch a test fail.

## J3. Stuck events: who may see and retry them

`deliveryProblems(app)` and `retryStuckEvent(app, service, eventId)` exist and do not check who is asking. Build the guarded versions.

1. **Permission** `operations:manage-events` in Identity (additive; decision #8). Held by TREASURY_ADMIN, for that tenant's events only, and by the platform role (`SYSTEM_ADMIN`), for all tenants. No other role has it. Update Identity's role table, README and tests.
2. **Functions** in `app/src/operations.ts`:
   - `listDeliveryProblems(app, actor, filter?)`: checks access with `checkAccess`; a tenant admin gets only events of their own tenant; the platform role gets all, and may filter by tenant. Returns service, tenant, event ID, event type, tries, last error (cut to 500 characters, since errors can quote data), next try or stuck time.
   - `deliveryProblemSummary(app, actor)`: counts by service and by state (waiting, stuck), for a badge or for the runtime's `/status`.
   - `retryDeliveryProblem(app, actor, { service, tenantId, eventId })`: checks access for that tenant, refuses an event that is not stuck (say what state it is in), and otherwise calls `retryStuckEvent`. The event ID is looked up **within the named tenant**, so one tenant's admin can never reach another tenant's event by guessing an ID.
3. **Audit.** Every retry is recorded (`event.retried`, target the event ID, field `service`). Find how `app/` may write an audit record: if Audit's contract has no direct command for an operator act (a retry is not a service's own change), write DECISION REQUIRED with this recommendation: add `recordOperation(fields)` to Audit's contract, called only from `operations.ts`.
4. Update decision 0019's "Not built" list and `docs/STATUS.md`. Skipping or discarding an event, retry-all, and alerts stay out of scope.

Done when: tests show a viewer, analyst, reviewer and approver are refused; a tenant admin sees and retries only their own tenant's events and cannot retry another tenant's event even with the right ID; the platform role sees and retries all (and the use is recorded as `platform-role.used`); a retried event is delivered on the next `drain`; a non-stuck event is refused with its state; an audit record exists for each retry. Break each check and watch a test fail.

## Not in this task

Screens and API (B, F), retention and purge of the audit trail, export of the trail, a platform-only view of platform-role use, one actor label format across services, alerts, contract versioning.

## Done when

1. J1, J2 and J3 are merged, each with a decision record, and the three rows of the Overview table are confirmed.
2. `npx tsc --noEmit`, `npm run check`, `npm test` pass.
3. `docs/STATUS.md` no longer lists these three as not built; the READMEs of Data Source, Identity and Audit are updated (60 lines or fewer each).
