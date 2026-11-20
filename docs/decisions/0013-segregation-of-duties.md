# 0013 Segregation of duties at approval

Date: 2026-11-19. Services: exposure-management (the rule and the switch), hedge-recommendation (answers who decided). Sources: decisions 0007 (two approval gates), 0011 (hedge decisions), 0012 (audit), the product owner's answers of 2026-11-19.

## Decided
1. **A tenant switch, on by default.** Treasury teams differ: a one-person shop must be able to run a cycle start to end, a larger team wants separation. Exposure Management keeps one setting per tenant, `segregationOfDuties`, true until someone switches it off. There is one switch for both rules, not one per rule.
2. **Two rules, when the switch is on.**
   - Whoever started a cycle, or reran it, cannot Approve Exposure on it.
   - Whoever accepted or overrode a hedge recommendation on a cycle cannot Approve Cycle on it.
3. **Same user ID; the platform role is not exempt.** The actor label (`user:<id>` or `platform:<id>`) is compared. A platform user is held to the rules like anyone else.
4. **Enforced in Exposure Management from recorded actors.** Starters and rerunners come from the cycle history it already keeps. Deciders come from Hedge Recommendation through its contract (`deciders(tenant, cycle)`), passed in as a port by `app/`, so Exposure Management imports nothing from it.
5. **Refusals are audited and name the rule, not the other person.** The message says "you started or reran this cycle" or "you accepted or overrode a hedge on this cycle". It never says who else acted. A refusal is recorded (`exposure.approval-refused-by-segregation-of-duties`, `cycle.approval-refused-by-segregation-of-duties`) in its own transaction, since the approval's transaction does not commit.
6. **Switching needs `authorization:manage`.** Changes are audited (`tenant.segregation-of-duties-set`); setting the value it already has changes and records nothing.

## Defaults I chose (change them if you disagree)
- The permission to switch is `authorization:manage`, the one that governs roles and restrictions.
- Dismissing a recommendation does not make you a decider. Your wording was "accepted or overrode".
- A decision still waiting on FX Trade counts as made. A claim FX Trade refused (which reopens the recommendation) does not.
- Other reasons to refuse (cycle not completed, already approved, missing permission) are checked first and are not written up as segregation refusals.
- Scheduler and system acts are not people and are not checked.
- Turning the switch off takes effect for the next approval; earlier refusals stand in the trail.

## Known gap (recorded, not built)
Cross-service race: one person submitting an accept and Approve Cycle at the same moment could pass, because the two services share no transaction. The starter rule is safe: rerun and approve serialize on the cycle row. Closing the gap would need Hedge Recommendation to hold decisions while a cycle approval is in flight, or the cycle to record a decision count at approval.
