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
    if ($day -eq "2026-10-27") { continue } # scenario 3 loads this after cycle start
    npm run load -- gl $file.FullName --tenant $tenant.id --chart UAT --as-of $day --source uat-gl --drain
    if ($LASTEXITCODE -ne 0) { throw "GL load failed: $day" }
  }
}
```

For scenario 3, use `BS-ENT` only: its cycle starts 2026-10-28 with as-of 2026-10-27 while that GL file is withheld. `BS-REG` starts only on Fridays and never has 2026-10-27 as an as-of date. Then load `gl/gl-2026-10-27.csv` into both tenants with the same `gl` command and tenant arguments as the loop above, and rerun the waiting `BS-ENT` cycle. Close it before starting the next `BS-ENT` cycle.

Load the malformed fixture with `--as-of 2026-11-20 --chart UAT --source uat-gl --tenant <id>` in place of a regular GL file. D5 must return `INVALID_FILE`, exit 1, all 40 problems at data rows 1–40 with the columns in `packs/uat/expected/gl-malformed-problems.json`, and store zero rows. Load `gl-dirty.csv` with the same options after the regular 2026-11-20 batch. It must return `APPLIED` and replace that source/date's current batch; reload `gl/gl-2026-11-20.csv` afterward to restore the baseline. Run these fixture demonstrations separately in each tenant so their results are not mixed with a cycle under review.

## Planted conditions and exact results

| Condition | File and date | Detection and expected result |
| --- | --- | --- |
| Malformed GL | `gl-malformed.csv`, 2026-11-20 | D parser: `INVALID_FILE`, exit 1, 40 problems, zero stored; row/column list in `expected/gl-malformed-problems.json`. |
| Parser-valid dirty GL | `gl-dirty.csv`, 2026-11-20 | Data Source: `APPLIED`, 20,000 stored, 20 blocked (`GL_ENTITY_UNKNOWN` 10, `GL_ACCOUNT_UNKNOWN` 10). `BS-ENT`: included 18,558, excluded 1,422. `BS-REG`: included 17,890, excluded 2,090. `expected/gl-dirty-expected.json` gives independent signed balance and row totals by currency for received, included, excluded and blocked, plus issue and exclusion reasons. E7 compares every J1 control total that the service exposes to these values, and compares the service's blocked issue counts to the two expected codes. The current Data Source contract exposes only aggregate excluded rows; Fikre chose aggregate comparison plus independent per-reason calculation, so the guide does not claim a service reason-specific exclusion count. |
| Missing EUR/USD | `rates/rates-2026-11-12.csv` | FX Rate file loads; Exposure Analysis waits with a reason beginning `Missing spot rates on 2026-11-12 for ` and listing every pair that needs the missing spot rate. `NO_RATE EUR-USD 2026-11-12` is E4's independent label in `expected-status.json`, not the platform's reason text. The cycle stays initiated and `expected/2026-11-12.csv` has no numeric rows. |
| Stale GBP/USD | `rates/rates-2026-11-13.csv`, observed 2026-11-12 16:30Z | FX Rate marks GBP/USD spot and forwards `STALE` under the 1,440-minute setting. Exposure Analysis may use the rate and shows a warning; compare numbers with `expected/2026-11-13.csv`. |
| AUD/USD outlier | `rates/rates-2026-11-16.csv` | FX Rate marks the 25% spot and forward jump `OUTLIER` against the prior valid rate and 10% threshold. The run may complete with a warning; compare `expected/2026-11-16.csv`. |
| Illustrative EUR holiday | `calendars.csv`, 2027-02-22, and the 3M forward in `rates/rates-2026-11-20.csv` | The generated forward quote is valid on 2027-02-23. To exercise the warning, start a `BS-ENT` roll cycle as of 2026-11-20, set near 2026-11-23 and enter far 2027-02-22. The recommendation must identify EUR as closed and suggest 2027-02-23; Approve Exposure is refused. Change far to 2027-02-23, rerun, then approve using the valid exact-date quote. |
| EUR long-to-short reversal | `gl/gl-2026-11-19.csv` and `gl/gl-2026-11-20.csv` | In `BS-ENT`/LE01/EUR-USD, gross EUR exposure moves from +19,475,280.26 to −19,473,230.25; see the two dated expected CSVs. |
| LE45 entirely excluded | Every GL file and both tenant mappings | Data Source excludes LE45's FX balances; its non-FX rows are also excluded. No LE45 exposure group appears in any dated expected CSV. |

The regular 2026-11-20 GL file should have zero blocked rows: `BS-ENT` has 18,588 included and 1,412 excluded; `BS-REG` has 17,919 included and 2,081 excluded. A D4 loader and database run confirmed these counts; the dirty fixture's account substitutions add ten non-FX exclusions, while one `BS-REG` account-1900 row is replaced by an unknown account and becomes blocked.

## Release 1 scenario map

The scenario names below are Fikre's Release 1 outline, word for word. The cycle column separates the start date from the data as-of date; the configured offset is one day. “Expected CSV” means the independent baseline amount to compare before any trade returned by the simulator is imported. Actions such as approvals, roll-date entry and an operator retry use platform commands; they do not come from a data file alone. Finish each cycle by approval, skip or delete before starting another one in the same program; an open cycle blocks the next scheduled start, and a missed day is not replayed automatically.

| # | Scenario | Cycle start / as-of | Files and actions | Expected result / evidence |
| --- | --- | --- | --- | --- |
| 1 | Onboard a tenant, load master data and users. | No cycle | `config.json`; six master files at 2025-11-20 | Two tenants, one program each; 50 entities, 40 currencies, 40 accounts in each; second configuration run refuses an existing tenant name. |
| 2 | Happy-path cycle from data to approved record. | `BS-ENT` 2026-10-27 / 2026-10-26 | `rates/rates-2026-10-26.csv`, `gl/gl-2026-10-26.csv`, `BS-ENT` history | Run completes; two approval gates produce a frozen record. Compare `expected/2026-10-26.csv`. Approve before scenario 3. |
| 3 | Late data, rerun, skip and delete. | `BS-ENT` late: 2026-10-28 / 2026-10-27; skip: 2026-10-29 / 2026-10-28; delete: 2026-10-30 / 2026-10-29 | Start the late cycle before loading `gl/gl-2026-10-27.csv`, then load it and rerun. Close that cycle; use separate subsequent cycles for skip and delete. | The late cycle waits, then completes with a new run ID and matches `expected/2026-10-27.csv`. A skipped or deleted cycle retains its prior run; no numeric comparison is claimed for those outcomes. `BS-REG` has no 2026-10-27 as-of cycle. |
| 4 | Dirty data: blocked balances and a missing rate. | Dirty `BS-ENT` 2026-11-21 / 2026-11-20; missing rate `BS-ENT` and `BS-REG` 2026-11-13 / 2026-11-12 | `gl-dirty.csv` for 2026-11-20; `rates/rates-2026-11-12.csv` | Dirty load counts above and `expected/gl-dirty-expected.json`; missing-rate runs wait with the platform reason stated above, while `expected-status.json` holds E4's label. Close waiting cycles before later starts. |
| 5 | Each strategy: ratio, threshold, Adjust+Swap, Close-out+New. | `BS-ENT` 2026-10-27 / 2026-10-26; `BS-REG` 2026-10-30 / 2026-10-29 | Each program's history and dated GL/rates. Before Approve Exposure, set `BS-ENT` roll near 2026-10-28 and far 2027-01-26; set `BS-REG` roll near 2026-11-02 and far 2027-01-28, with offset 0. Rerun after setting dates. | The near dates cover maturing history and the far dates are open joint business days. `BS-ENT` uses hedge ratio with Adjust+Swap; `BS-REG` uses amount threshold with Close-out+New. Compare `expected/2026-10-26.csv` and `expected/2026-10-29.csv` before the policy decision. |
| 6 | Accept, override with a split, dismiss. | `BS-ENT` 2026-11-21 / 2026-11-20 | `gl/gl-2026-11-20.csv`, same-day rates, `expected/2026-11-20.csv`; set roll near 2026-11-23, far 2027-02-23, offset 0, then rerun before Approve Exposure. | Decide three recommendations separately; a large override respects the configured maximum and creates split parts. The amount baseline is the dated CSV; decision and part counts come from Hedge Recommendation. The roll dates belong to this cycle and must be entered again even if scenario 5 ran. |
| 7 | Approve Exposure and Approve Cycle with segregation of duties. | `BS-ENT` 2026-11-21 / 2026-11-20 | `config.json` users, `gl/gl-2026-11-20.csv`, rates; set roll near 2026-11-23, far 2027-02-23, offset 0, and rerun before Approve Exposure. | Starter cannot approve exposure; the exposure decider cannot approve the cycle. Different authorized users complete both gates; the approved exposure matches `expected/2026-11-20.csv`. Scenarios 6 and 7 may use the same cycle and roll-date entry. |
| 8 | Release pre-trades, return the executed file, match, follow up. | `BS-ENT` 2026-11-20 / 2026-11-19 | Set roll near 2026-11-27, far 2027-02-23, offset 0, then rerun before Approve Exposure. Accept and release a EUR/USD recommendation; export its pre-trade file and use `rates/rates-2026-11-20.csv` for simulation. | The near date includes the maturing EUR/USD `HIST-00201` trade. The November 20 rate file has EUR/USD spot and a 3M forward quoted for 2027-02-23, so the simulator can price both legs of the selected EUR/USD package. After approval and release, run `npm run uat:simulate -- --pretrades <file> --rates packs/uat/generated/rates/rates-2026-11-20.csv --trade-date 2026-11-20 --seed 20261120 --out <executed.csv>`; import the output and confirm its PT reference matches. |
| 9 | Next cycle begins with all outstanding hedges including the ones executed in the prior cycle. | `BS-ENT` 2026-11-21 / 2026-11-20 | `BS-ENT` executed history; scenario 8's EUR/USD legs traded 2026-11-20; `gl/gl-2026-11-20.csv` and `rates/rates-2026-11-20.csv`. Set this new cycle's roll near 2026-11-23, far 2027-02-23, offset 0, then rerun before approval. | Close scenario 8's cycle first. Both imported EUR/USD legs have value dates after 2026-11-20 (near 2026-11-27, far 2027-02-23), so both remain outstanding in this as-of run alongside historical open legs. `expected/2026-11-20.csv` is the pre-simulator baseline; verify the added legs separately against the import. |
| 10 | Correction after approval as a new cycle. | `BS-ENT` initial scheduled 2026-11-21 / 2026-11-20; correction manual later / same 2026-11-20 as-of | Load and approve `gl-dirty.csv` for 2026-11-20, then replace that source/date batch with `gl/gl-2026-11-20.csv`. Run separately from the clean approval scenario. | The approved dirty-data cycle remains unchanged. Start a new manual cycle at the same as-of date for the correction; its exposure matches `expected/2026-11-20.csv`. |
| 11 | Audit review and chain check; program-restricted access. | Uses approved cycles above; no new cycle | Configuration, master loads and approved cycles | In the `BS-ENT` tenant, Mara (admin) reads its program records and verifies the chain. After scenario 7, restrict Ivo (approver) to `NO-ACCESS-UAT`, a test-only program ID that is not enabled in that tenant, using Identity's `setProgramRestriction`; Ivo has `audit:read` through the approver role but must see no `BS-ENT` records and cannot verify the tenant-wide chain. Clear that restriction with `null` after the check. Also confirm an actor from the `BS-REG` tenant cannot read `BS-ENT` records. No numeric expected CSV applies. |
| 12 | A failed delivery and an operator retry. | `BS-ENT` 2026-11-14 / 2026-11-13 | Cause a delivery failure after a 2026-11-13 rate or GL load | Delivery records the failure and retry state; operator retry succeeds once and the tenant's subsequent event proceeds. `expected/2026-11-13.csv` remains the numeric reference. |

The exact operator commands in scenario 12 depend on J's backend work and the rehearsal entry point. E7 will exercise them against a fresh `_uat` database. The guide's data dates, expected CSVs and file-level outcomes are fixed here; loader-backed and end-to-end results are still pending.
