# Release 1 UAT data guide (E6)

## Company and pack

Northstar Meridian Group is fictional. Its 50 entity records are one group, four regions and 45 legal entities; three are treasury entities and two can execute hedges. The shared master data has 40 currencies (ten marked NDF), 25 hierarchy nodes and 40 accounts. Two tenants load the same master data, rates and GL files: `BS-ENT` nets daily by entity, while `BS-REG` nets weekly by region. Each tenant has one balance sheet program and its own users and policy. All banks, people and holidays are fictional or illustrative.

The generator uses seed `20261120`. Its manifest, small master files and the independent expected results are committed. Generate the 20 GL files (20,000 rows each), 262 daily rate files and the two program-specific executed-trade histories locally. The manifest lists every file's row count and SHA-256. `docs/uat/generator.md` and `docs/uat/expected-results.md` describe the generation and calculation rules.

## Load order

The `npm run load` commands below are the D5 CLI contract from `docs/release-1/D-data-loaders.md`; D5 is not merged yet. Use a fresh database whose name ends `_uat`. `uat:configure` prints the two tenant IDs in config order: first `BS-ENT`, then `BS-REG`. Substitute those IDs below. Keep `DATABASE_URL` set in the shell; each `--drain` delivers the resulting event before the next command.

```powershell
$env:DATABASE_URL = "postgres://.../fx_uat"
npm run db:migrate
npm run uat:generate -- --seed 20261120 --out packs/uat/generated
npm run uat:expected
npm run uat:configure -- --config packs/uat/config.json
$tenants = @(
  @{ id = "<first tenant ID printed by configure>"; program = "BS-ENT" },
  @{ id = "<second tenant ID printed by configure>"; program = "BS-REG" }
)
$pack = "packs/uat/generated"
$masterDate = "2025-11-20"
foreach ($tenant in $tenants) {
  foreach ($kind in @("currencies", "calendars", "entities", "hierarchy", "accounts")) {
    npm run load -- $kind "$pack/$kind.csv" --tenant $tenant.id --source uat-master --as-of $masterDate --mode SNAPSHOT --drain
    if ($LASTEXITCODE -ne 0) { throw "Master load failed: $kind" }
  }
  npm run load -- exposure-currencies "$pack/exposure-currencies.csv" --tenant $tenant.id --source uat-master --as-of $masterDate --mode SNAPSHOT --program $tenant.program --drain
  if ($LASTEXITCODE -ne 0) { throw "Exposure-currency load failed" }
  foreach ($file in (Get-ChildItem "$pack/rates/rates-*.csv" | Sort-Object Name)) {
    $day = [regex]::Match($file.Name, '\d{4}-\d{2}-\d{2}').Value
    npm run load -- rates $file.FullName --tenant $tenant.id --source uat-rates --business-date $day --drain
    if ($LASTEXITCODE -ne 0) { throw "Rate load failed: $day" }
  }
  npm run load -- executed "$pack/executed-history-$($tenant.program).csv" --tenant $tenant.id --drain
  if ($LASTEXITCODE -ne 0) { throw "Executed history load failed" }
  foreach ($file in (Get-ChildItem "$pack/gl/gl-*.csv" | Sort-Object Name)) {
    $day = [regex]::Match($file.Name, '\d{4}-\d{2}-\d{2}').Value
    npm run load -- gl $file.FullName --tenant $tenant.id --chart UAT --as-of $day --source uat-gl --drain
    if ($LASTEXITCODE -ne 0) { throw "GL load failed: $day" }
  }
}
```

Load the malformed fixture with `--as-of 2026-11-20 --chart UAT --source uat-gl --tenant <id>` in place of a regular GL file. D5 must return `INVALID_FILE`, exit 1, all 40 problems at data rows 1–40 with the columns in `packs/uat/expected/gl-malformed-problems.json`, and store zero rows. Load `gl-dirty.csv` with the same options after the regular 2026-11-20 batch. It must return `APPLIED` and replace that source/date's current batch; reload `gl/gl-2026-11-20.csv` afterward to restore the baseline. Run these fixture demonstrations separately in each tenant so their results are not mixed with a cycle under review.

## Planted conditions and exact results

| Condition | File and date | Detection and expected result |
| --- | --- | --- |
| Malformed GL | `gl-malformed.csv`, 2026-11-20 | D parser: `INVALID_FILE`, exit 1, 40 problems, zero stored; row/column list in `expected/gl-malformed-problems.json`. |
| Parser-valid dirty GL | `gl-dirty.csv`, 2026-11-20 | Data Source: `APPLIED`, 20,000 stored, 20 blocked (`GL_ENTITY_UNKNOWN` 10, `GL_ACCOUNT_UNKNOWN` 10). `BS-ENT`: included 18,558, excluded 1,422. `BS-REG`: included 17,890, excluded 2,090. Independent exclusion reasons are in `expected/gl-dirty-plants.json`. The service exposes total excluded, not a reason-specific count; compare its total with the independent calculation, as Fikre chose. |
| Missing EUR/USD | `rates/rates-2026-11-12.csv` | FX Rate file loads; Exposure Analysis waits with `NO_RATE EUR-USD 2026-11-12`, cycle stays initiated. `expected/2026-11-12.csv` has no numeric rows; `expected-status.json` records the wait. |
| Stale GBP/USD | `rates/rates-2026-11-13.csv`, observed 2026-11-12 16:30Z | FX Rate marks GBP/USD spot and forwards `STALE` under the 1,440-minute setting. Exposure Analysis may use the rate and shows a warning; compare numbers with `expected/2026-11-13.csv`. |
| AUD/USD outlier | `rates/rates-2026-11-16.csv` | FX Rate marks the 25% spot and forward jump `OUTLIER` against the prior valid rate and 10% threshold. The run may complete with a warning; compare `expected/2026-11-16.csv`. |
| Illustrative EUR holiday | `calendars.csv`, 2027-02-22, and the 3M forward in `rates/rates-2026-11-20.csv` | 2027-02-22 is closed for EUR; a recommendation using that value date needs a new joint business date. The next illustrative EUR/USD joint business day is 2027-02-23. This is a calendar check, not a CSV parser error. |
| EUR long-to-short reversal | `gl/gl-2026-11-19.csv` and `gl/gl-2026-11-20.csv` | In `BS-ENT`/LE01/EUR-USD, gross EUR exposure moves from +19,475,280.26 to −19,473,230.25; see the two dated expected CSVs. |
| LE45 entirely excluded | Every GL file and both tenant mappings | Data Source excludes LE45's FX balances; its non-FX rows are also excluded. No LE45 exposure group appears in any dated expected CSV. |

The regular 2026-11-20 GL file should have zero blocked rows: `BS-ENT` has 18,588 included and 1,412 excluded; `BS-REG` has 17,919 included and 2,081 excluded. These are independent calculations awaiting a D loader and database run. The dirty fixture's account substitutions add ten non-FX exclusions, while one `BS-REG` account-1900 row is replaced by an unknown account and becomes blocked.

## Release 1 scenario map

The scenario names below are Fikre's Release 1 outline, word for word. “Expected CSV” means the independent baseline amount to compare before any trade returned by the simulator is imported. Actions such as approvals, a policy switch and an operator retry use platform commands; they do not come from a data file alone.

| # | Scenario | Files and dates | Expected result / evidence |
| --- | --- | --- | --- |
| 1 | Onboard a tenant, load master data and users. | `config.json`; six master files at 2025-11-20 | Two tenants, one program each; 50 entities, 40 currencies, 40 accounts in each; second configuration run refuses an existing tenant name. |
| 2 | Happy-path cycle from data to approved record. | `rates/rates-2026-10-26.csv`, `gl/gl-2026-10-26.csv`, program history | Run completes; two approval gates produce a frozen record. Compare `expected/2026-10-26.csv`. |
| 3 | Late data, rerun, skip and delete. | Start 2026-10-27 before `gl/gl-2026-10-27.csv`; then load it. Use 2026-10-28 for skip/delete demonstrations. | Empty-data cycle waits, late load completes it, rerun gets a new run ID. Skip/delete leave their run as it was; compare `expected/2026-10-27.csv` and `expected/2026-10-28.csv` only for completed runs. |
| 4 | Dirty data: blocked balances and a missing rate. | `gl-dirty.csv` on 2026-11-20; `rates/rates-2026-11-12.csv` | Dirty load counts above and `expected/gl-dirty-plants.json`; missing-rate run waits per `expected-status.json`. |
| 5 | Each strategy: ratio, threshold, Adjust+Swap, Close-out+New. | `BS-ENT` 2026-10-26 and 2026-11-20; `BS-REG` 2026-10-30; program histories | Ratio and threshold use the configured policies. Adjust+Swap uses `BS-ENT` with maturing history. To demonstrate Close-out+New, set `BS-ENT` to that strategy for a separate cycle; then use the maturing history. Compare the applicable dated expected CSV before the policy decision. |
| 6 | Accept, override with a split, dismiss. | `gl/gl-2026-11-20.csv`, same-day rates, `expected/2026-11-20.csv` | Decide three recommendations separately; a large override respects the configured maximum and creates split parts. The amount baseline is the dated CSV; decision and part counts come from Hedge Recommendation. |
| 7 | Approve Exposure and Approve Cycle with segregation of duties. | `config.json` users, `gl/gl-2026-11-20.csv`, rates | Starter cannot approve exposure; the exposure decider cannot approve the cycle. Different authorized users complete both gates; the approved exposure matches `expected/2026-11-20.csv`. |
| 8 | Release pre-trades, return the executed file, match, follow up. | Pre-trade export for 2026-11-19; `rates/rates-2026-11-19.csv`; simulator output | Run `npm run uat:simulate -- --pretrades <file> --rates packs/uat/generated/rates/rates-2026-11-19.csv --trade-date 2026-11-19 --seed 20261120 --out <executed.csv>`; import its output. Every full fill echoes its PT reference and matches. |
| 9 | Next cycle begins with all outstanding hedges including the ones executed in the prior cycle. | Program-specific `executed-history-*.csv`; simulator output from scenario 8 on 2026-11-19; `gl/gl-2026-11-20.csv` and `rates/rates-2026-11-20.csv` | The next run includes historical open legs and the newly executed prior-cycle legs. `expected/2026-11-20.csv` is the pre-simulator baseline; verify the added legs separately against the import. |
| 10 | Correction after approval as a new cycle. | Load and approve `gl-dirty.csv` at 2026-11-20, then replace that source/date batch with `gl/gl-2026-11-20.csv` | The approved dirty-data cycle remains unchanged. Start a new cycle at the same as-of date for the correction; its exposure matches `expected/2026-11-20.csv`. |
| 11 | Audit review and chain check; program-restricted access. | Configuration, master loads and approved cycles above | An authorized approver or admin sees permitted program records and a valid chain; a user restricted to the other tenant/program cannot read them. No numeric expected CSV applies. |
| 12 | A failed delivery and an operator retry. | Cause a delivery failure after a 2026-11-13 rate or GL load | Delivery records the failure and retry state; operator retry succeeds once and the tenant's subsequent event proceeds. `expected/2026-11-13.csv` remains the numeric reference. |

The exact operator and policy commands in scenarios 5 and 12 depend on J's backend work and the rehearsal entry point. E7 will exercise them against a fresh `_uat` database. The guide's data dates, expected CSVs and file-level outcomes are fixed here; loader-backed and end-to-end results are still pending.
