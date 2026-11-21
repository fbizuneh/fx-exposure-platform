# 0029 — Audit records for Data Source and Exposure Analysis

Date: 2026-11-21. Services: data-source, exposure-analysis. Source: `docs/release-1/J-backend-gaps.md` (J2), confirmed as decision row #7 (Overview table) by Fikre on 2026-11-20.

(Numbered 0029 from `main` at the time this branch started; J1 also claims 0029 from its own branch. The two PRs are independent, so whichever merges second renumbers its decision file.)

## Decided

1. **Data Source gets the same `change-record.ts` pattern as Master Data and FX Rate**: `recordChange` (announces `data-source.change-recorded`, built from `ChangeRecordFields`) and `byPerson` (an actor is `user:<id>` or `platform:<id>`; anything else — a connector name, a source system — is a routine feed and is not recorded). Both are plain functions over `Queryable`/a string, not a new abstraction.
2. **Three actions, exactly as J2's table specifies, with no service prefix** (matching the newer convention in Exposure Management, Hedge Recommendation, FX Trade and Identity — `cycle.started`, not `exposure-management.cycle.started`):
   - `batch.loaded` — target the batch ID, no fields, `programId: null` (a batch is not itself scoped to one program: its rows can be stamped with different programs, same as the existing `data-source.batch-stamped` event already carries no `programId`). Recorded only on the `APPLIED` path, in the same transaction as the batch's insert; a `DUPLICATE` (nothing changed) or a refused/`FAILED` batch (nothing was loaded) records nothing.
   - `mapping-rule.added` — target the rule ID, no fields, `programId` the rule's own program (mapping rules are program-scoped, per their migration's `-- program-scoped` marker and AGENTS.md rule 6).
   - `mapping-rule.ended` — target the rule ID, field `validTo`, same `programId` rule. `endMappingRule(tenant, ruleId, endsOn)` had no `by`; it now takes one (as decision 0012 added one to `setProgramRestriction`) and its body moved into a transaction, since the update and the record must commit together. Its one test call site, and any future caller, must pass `by`.
3. **Exposure Analysis records nothing.** Its contract and `src/run.ts` were read end to end: `onCycleInitiated`, `retryWaiting`, `onExposureApproved` and `onCycleApproved` are its only commands, and every call site (`app/src/dispatch.ts`) is the dispatcher reacting to another service's event — never a person. There is no manual override, no resolution of a data issue, and no setting to change. Per J2's explicit instruction, this is recorded as a finding, not invented: **no change record is added for Exposure Analysis in this task.**

## Found along the way (not fixed here, per J2's scope)
- FX Rate's `setStaleAfter`, `setPreferredSource`, `setPivotCurrency`, `setOutlierShare` and Master Data's `setMaxEndShare` take no actor and are not recorded, though they change what exposures are computed from. Left for Fikre to decide, as the J file asks.

## Tests
- `services/data-source/src/data-source.db.test.ts`: a person's batch load is recorded once; a connector feed and a duplicate batch record nothing; a refused batch records nothing; a person's mapping-rule add and end are recorded with the rule's program and (for the end) the `validTo` field; a routine feed's add/end and a refused end record nothing.
- `app/src/end-to-end.db.test.ts`: a person's batch load and mapping-rule add/end reach Audit's trail (through the real dispatcher) with the right tenant, program and fields; a feed's load does not; the chain verifies; a duplicate batch and a re-delivered announcement each add nothing more. (The dispatcher's "any `.change-recorded` event goes to Audit" rule, and Audit's own same-record-twice idempotency, are generic and already covered for other services; this test exercises the Data Source-specific wiring.)
- Each new rule was broken (the `byPerson` guard short-circuited to `false`) and watched to fail, then restored.

## Cost
Mapping rules needed a new column in no table and no migration — `programId` was already stored on the row; only the function signature changed. `endMappingRule` moving into a transaction is one more round trip only when it is used to end a rule (not a hot path).
