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

Both balance sheet programs use the same GL, with distinct mapping rules. `BS-ENT` runs daily at ENTITY netting. Its hedge-ratio-adjustment policy has a 0.75 default ratio, a 0.90 override for one pair, and Adjust + Swap rolling. `BS-REG` runs weekly at REGION netting. Its amount-threshold policy has one USD threshold and no threshold override or roll. Both have a minimum amount, currency rounding, 3M tenor, a trading entity and a maximum amount. Every policy must pass `policyProblems` before it is saved. The configured actors are a tenant admin, analyst, reviewer, approver, viewer and platform user. Segregation of duties remains on; the starter and both approvers are assigned so the gates can be exercised by different people.

## Controlled failures

| Fixture | Stage | Expected behavior |
| --- | --- | --- |
| `gl-malformed.csv`, 20,000 rows | D's GL parser | Exactly 40 planted file-shape problems, each named by row and column; `INVALID_FILE`, CLI exit 1, zero rows stored. Problems cover conflicting balance/debit/credit, no amount, invalid date, invalid currency code, nonnumeric amount and missing required cell. |
| `gl-dirty.csv`, 20,000 rows | Data Source and Exposure Analysis | Parser accepts every row; the batch is `APPLIED`. Unknown entity, unknown account and excluded account counts come from the services' batch result and issue questions. Exact counts will be fixed against those contracts, then written to `packs/uat/expected/`. |
| Missing rate on one day/pair | Rates or exposure stage | The missing-rate condition is checked where rates are consumed; it is absent from both GL failure fixtures. |

Other planted cases are a stale rate, an outlier rate, a holiday on a value date, the long-to-short reversal and the fully excluded entity. The data guide will name their exact dates and expected results after the generated files and loader are available.

## Handoffs and decisions

E3 starts after D1's `docs/file-layouts.md` is merged and agreed. E7 needs D's loaders and J's backend work. The UAT scenario table needs the Release 1 outline's scenarios from Fikre's Claude Docs. The design is ready for review; E1 is done only when Fikre agrees and it is merged.

**DECISION REQUIRED — simulated settlement amounts.** Recommendation pre-trade files may have an empty `settlement_amount`; FX Trade's executed importer requires a positive amount. Options: (A) derive the amount from the pack's spot/forward rate for the trade date and tenor (recommended; realistic and reusable, but couples the simulator to the rate files); (B) use a fixed rate in config (simple, but executed values may not agree with UAT rates). The simulator's database acceptance test depends on this choice.

**DECISION REQUIRED — two programs on one GL.** `combinationProblem` currently refuses a second `BALANCE_SHEET` program in a tenant. Data Source also refuses mapping rules that let two programs claim the same balance. Options: (A) amend both service rules to allow the two UAT programs to consume the same GL (recommended for the agreed Release 1 scenario; changes platform behavior and needs service decisions, migrations or tests as appropriate); (B) keep the one-program rule and revise E to use one program per tenant (less platform change, but loses the required same-GL comparison). E2, E4 and E7 cannot run as specified before this is settled.

**DECISION REQUIRED — duplicate tenant name.** Identity's `createTenant` allows duplicate names, and its questions do not expose a name lookup. Options: (A) make tenant names unique in Identity and expose a lookup or refusal (recommended; durable and race safe, but changes Identity's contract and schema); (B) use a UAT-only registry (no Identity change, but it can diverge from the actual tenants). E2 cannot promise to refuse an existing name without this.

**DECISION REQUIRED — exact scenario mapping.** The scenario descriptions and numbers are only in Fikre's Release 1 outline. Provide that section so E6 can map each scenario to a dated file and expected CSV without inventing cases.
