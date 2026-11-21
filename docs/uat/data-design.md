# Release 1 UAT data design (E1)

This is the proposed design for Fikre's review. The data is entirely fictional. The group, entities, banks and people must not reuse customer, bank or brand names. Illustrative holidays are labelled as such in the generated calendar and guide. The generator takes one seed; a repeated seed must produce byte-identical files.

## Organization and currencies

- One group, with AMER, EMEA, APAC and LATAM regions. There are 50 entity records: the group, four regions and 45 legal entities. Among the legal entities, three carry the treasury-entity flag and two carry the hedge-execution-entity flag. Each legal entity belongs to one region and has one functional currency.
- There are 40 currencies, including USD as reporting, display and rate pivot currency. At least six are marked non-deliverable. At least two calendars use a Friday/Saturday weekend. Dates are illustrative, not market calendars.
- One chart has about 25 hierarchy nodes and 40 accounts. Thirty accounts are monetary and FX-relevant (cash, trade AR/AP, intercompany loans and balances, deposits, accruals); ten are non-FX (inventory, equipment, equity). The flags and mapping rules exclude the latter.

## Financial data and history

- Each daily GL file has exactly 20,000 rows. A row is unique by entity, account, currency and dimensions; some rows have `cost_center`. Every legal entity has balances in its functional currency and 6–12 other currencies.
- Receivables and payables offset naturally in some entity/pair groups. Other groups remain net long or short. Intercompany balances have both directions. About 5% of rows use non-FX accounts. A designated currency reverses its net direction between two adjacent days, and one legal entity has every row excluded.
- Twenty consecutive business dates have GL files. Balances evolve by a few percent per day. Twelve months of daily spot and 1M, 3M, 6M and 12M forward rates cover 39 USD pairs, except for one planted missing rate. A stale rate and a flagged outlier are separate planted conditions. Forward points use configured interest differentials. Twelve months of executed hedge trades provide outstanding hedge history.
- Money is decimal text: JPY and KRW have no fractional digits; other currencies have two. The generator and independent expected-results script use `decimal.js`, never binary floating point.

## Programs and people

Two tenants load the same generated master data, rates and GL files, one program per tenant. Each tenant has 50 entity records, 40 currencies and a 20,000-row daily GL batch. `BS-ENT` runs daily at ENTITY netting. Its hedge-ratio-adjustment policy has a 0.75 default ratio, a 0.90 override for one pair, and Adjust + Swap rolling. `BS-REG` runs weekly at REGION netting. Its amount-threshold policy has one USD threshold, no threshold override, and Close-out+New rolling. Fikre chose this pairing to cover all four strategies in scenario 5. Each tenant has its own mapping rules, hedge policy and five tenant users (admin, analyst, reviewer, approver, viewer); a platform user is outside both tenants. Both policies have a minimum amount, currency rounding, 3M tenor, a trading entity and a maximum amount. Every policy must pass `policyProblems` before it is saved. Segregation of duties remains on, with different people for the two approval gates.

## Controlled failures

| Fixture | Stage | Expected behavior |
| --- | --- | --- |
| `gl-malformed.csv`, 20,000 rows | D's GL parser | Exactly 40 planted file-shape problems, each named by row and column; `INVALID_FILE`, CLI exit 1, zero rows stored. Problems cover conflicting balance/debit/credit, no amount, invalid date, invalid currency code, nonnumeric amount and missing required cell. |
| `gl-dirty.csv`, 20,000 rows | Data Source and Exposure Analysis | Parser accepts every row; the batch is `APPLIED`. Compare J1's batch control totals by currency with independently calculated totals, and independently calculate unknown-entity, unknown-account and excluded-account rows and their amounts without platform code. Data Source's total included/excluded/blocked counts and blocked issue codes are checked against that calculation; it does not report exclusion reasons. Exact expected values live in `packs/uat/expected/`. |
| Missing rate on one day/pair | Rates or exposure stage | The missing-rate condition is checked where rates are consumed; it is absent from both GL failure fixtures. |

Other planted cases are a stale rate, an outlier rate, a holiday on a value date, the long-to-short reversal and the fully excluded entity. The generated 2026-10-27 GL file is the late-file case: the load sequence withholds it in both tenants until after the cycle starts, then loads it and reruns. The data guide names the dates and expected results.

## Handoffs and decisions

D1's `docs/file-layouts.md` has merged, so E3 is underway. E7 needs D's loaders and J's backend work. Fikre supplied the Release 1 scenarios below. E1 is done when this design is reviewed and merged.

**Decided — simulated settlement amounts.** Fikre chose to derive the executed settlement amount from generated rates. The simulator therefore needs the generated rates for its trade date and value date; a missing rate must refuse simulation rather than invent an amount.

**Decided — one program per tenant.** Fikre confirmed two UAT tenants, each with one balance sheet program. They load the same generated files into separate tenant scopes. The existing one-balance-sheet-program rule and Data Source's single-program stamp stay in force.

**Decided — duplicate tenant name.** Fikre chose a unique tenant-name rule and Identity lookup. E2 will call Identity's contract and refuse before any configuration write if the name exists; Identity must still enforce uniqueness atomically for concurrent callers.

## UAT scenario checklist

Fikre supplied the Release 1 outline's scenario section verbatim. E6 will map each item to exact generated files, dates and expected CSVs after E3 and E4 produce them.

1. Onboard a tenant, load master data and users.
2. Happy-path cycle from data to approved record.
3. Late data, rerun, skip and delete.
4. Dirty data: blocked balances and a missing rate.
5. Each strategy: ratio, threshold, Adjust+Swap, Close-out+New.
6. Accept, override with a split, dismiss.
7. Approve Exposure and Approve Cycle with segregation of duties.
8. Release pre-trades, return the executed file, match, follow up.
9. Next cycle begins with all outstanding hedges including the ones executed in the prior cycle.
10. Correction after approval as a new cycle.
11. Audit review and chain check; program-restricted access.
12. A failed delivery and an operator retry.
