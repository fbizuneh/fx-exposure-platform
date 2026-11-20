# 0013 Segregation of duties at approval

Date: 2026-11-19. Services: exposure-management (the rule and the switch), hedge-recommendation (answers who decided). Sources: decisions 0007 (two approval gates), 0011 (hedge decisions), 0012 (audit), the product owner's answers of 2026-11-19.

## Decided
1. **A tenant switch, on by default.** Treasury teams differ: a one-person shop must be able to run a cycle start to end, a larger team wants separation. Exposure Management keeps one setting per tenant, `segregationOfDuties`, true until someone switches it off. There is one switch for both rules, not one per rule.
2. **Two rules, when the switch is on.**
   - Whoever started a cycle, or reran it, cannot Approve Exposure on it.
   - Whoever accepted or overrode a hedge recommendation on a cycle cannot Approve Cycle on it.
3. **Same user ID; the platform role is not exempt.** The actor label (`user:<id>` or `platform:<id>`) is compared. A platform user is held to the rules like anyone else.
4. **Enforced in Exposure Management from recorded actors, without a transaction across services.**
   - *Approve Exposure* is decided in one transaction. After the cycle row is locked, it reads who started or reran the cycle (from the cycle history) and the tenant policy, so a rerun cannot land between the check and the approval, and the check never uses history older than the lock.
   - *The tenant policy is serialized.* A change to the setting holds a per-tenant lock exclusively for its whole transaction (compare, write, audit). Every approval reads the policy under the same lock held shared until it commits. A change is therefore wholly before or wholly after any approval, and waits for approvals already reading the old value.
   - *Approve Cycle* needs facts that live in Hedge Recommendation, so it uses a durable reservation (a handshake) instead of a lookup. With the switch on, the approval (1) checks state and policy and finds it must reserve, (2) asks Hedge Recommendation to reserve the approval for this person, (3) commits the approval, (4) releases the reservation. Hedge Recommendation takes one per-cycle lock for both reserving and for the claim that starts an accept or override (OPEN to DECIDING). Under that lock, a reservation is refused if the person has already won an accept or override (a decision waiting on FX Trade counts), and a claim is refused if the same person holds a reservation. Whichever comes first wins, so one person can never win both. Exposure Management never calls Hedge Recommendation inside its own transaction; `app/` hands the two calls in as a port.
5. **Reservations are recoverable.** Each approval attempt gets its own reservation ID, so one attempt's release cannot drop another's. A reservation is released when the approval commits, fails or is refused; a failed release does not hide the approval's outcome. If a release never happens (a crash, Hedge Recommendation unreachable), the reservation only stops its holder from winning decisions on that cycle; it is cleared when the cycle is approved, skipped or deleted (Hedge Recommendation handles the cycle's closing event), and a retried approval makes a new reservation, so retrying is safe and repeats change nothing. A reservation is taken only while the policy is on. If the switch is turned off while one is in flight, the approval proceeds, since it is then allowed.
6. **Refusals are audited and name the rule, not the other person.** The message says "you started or reran this cycle" or "you accepted or overrode a hedge on this cycle". It never says who else acted. A refusal is recorded (`exposure.approval-refused-by-segregation-of-duties`, `cycle.approval-refused-by-segregation-of-duties`) in its own transaction, since the approval's transaction does not commit.
7. **Switching needs `authorization:manage`.** Changes are audited (`tenant.segregation-of-duties-set`). Comparing, writing and auditing happen under the tenant policy lock, so each actual change, including the first from the implicit default, is recorded exactly once however many arrive together. Setting the value it already has writes nothing at all: no row, no `updated_by` or `updated_at`, no record. A tenant with no row is on.

## Defaults I chose (change them if you disagree)
- The permission to switch is `authorization:manage`, the one that governs roles and restrictions.
- Dismissing a recommendation does not make you a decider. Your wording was "accepted or overrode".
- A decision still waiting on FX Trade counts as made. A claim FX Trade refused (which reopens the recommendation) does not.
- Other reasons to refuse (cycle not completed, already approved, missing permission) are checked first and are not written up as segregation refusals.
- Scheduler and system acts are not people and are not checked.
- Turning the switch off takes effect for the next approval; earlier refusals stand in the trail.

## Known gaps (recorded, not built)
- A reservation whose release is lost stays until the cycle is approved, skipped or deleted, and until then stops its holder (only) from winning hedge decisions on that cycle. `approvalHolds(tenant, cycle)` shows who holds one. No expiry, because an expiry would reopen the race while an approval is still in flight.
- If the switch is turned off after a reservation was made, the holder is still barred from winning decisions until the reservation is released or cleared.
