# 0007 Exposure Management: programs, settings and the cycle

Date: 2026-11-18. Service: exposure-management (core tier).

## Decided
1. **Settings in this build are the ones already decided:** program code, name and type; netting level (entity and pair, corporate and pair, region and pair); a date-bucket scheme; and a schedule. Hedge policy settings are added, as a migration, when Hedge Recommendation is built. Settings are effective-dated, and each cycle keeps a copy of the settings in force on its as-of date.
2. **Programs and Identity.** A platform admin enables a program code in Identity. Exposure Management then defines it, and only for an enabled code (it asks Identity). It keeps an enabled flag current from Identity's events. Combination rules are enforced at definition: one balance sheet program per tenant, and classic programs (balance sheet, cash flow, in-house bank) and Budget to Cash cannot coexist.
3. **Stages come from events.** Exposure Management announces "cycle initiated". Exposure Analysis announces "run started" and "run finished", and Exposure Management moves the cycle to in progress and completed. This adds "run started" to Exposure Analysis's contract. Both events carry a **run ID**, and a "run finished" counts only if its run ID is the one that started, so a late event from a run that was replaced by a rerun cannot complete the cycle.
4. **The schedule is data.** A frequency (daily, weekly on a day, monthly on a day of 1 to 28) and an as-of offset in days. Exposure Management answers "which cycles are due on this date" for a tenant, and a timer in `app/` starts them. A missed day is not backfilled.
5. **Approval** is recorded and announced. Each service freezes its own part under the cycle ID. Recording which parts confirmed they froze comes with the first service that freezes (Exposure Analysis).

## Defaults I chose, to confirm or change
- One open cycle per tenant and program. Open means not approved, skipped or deleted.
- A cycle's as-of date cannot be in the future, and settings must be in force on it.
- Permissions are checked by asking Identity: `cycle:initiate` to start or rerun, `cycle:skip` to skip or delete, `cycle:approve` to approve, `program:manage` to define a program or change its settings. Program-restricted users are respected.
- A deleted cycle is kept as an outcome with a reason, never removed. A reason is required to skip or delete.
- Approval needs a completed cycle with no outcome. Approved cycles never change.
- A rerun is allowed before approval, from initiated or completed (not while a run is in progress), and is counted on the cycle record. It announces "cycle initiated" again.
- Blocked balances do not stop a cycle. Their count belongs to the run and is shown at approval.
- A settings change takes effect on a later date than the one before it. History is never rewritten.
- Schedules are in UTC dates, with no time of day. The Balance Sheet variants (daily, monthly, rolling) are expressed through the schedule.
- Events: cycle initiated, completed, approved, skipped, deleted, and program changed.

## Not built yet
Frozen-part pointers, hedge policy settings, deleting a program, editing a program's name or type, and the screens.

## Revisit when
Exposure Analysis or Hedge Recommendation needs a setting that is not here, or a schedule needs a time of day or time zone.
