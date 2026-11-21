# UAT generator (E3)

Run `npm run uat:generate -- --seed 20261120 --out packs/uat/generated`. The optional `--config` defaults to `packs/uat/config.json`; its `generator` section holds the date range, chart, rate source, initial USD rates, daily volatility in basis points, annual interest assumptions, NDF flags and weekend conventions. The same generated files are loaded into both UAT tenants, one program per tenant. The output manifest records every file's row count and SHA-256 digest. Large generated files are ignored by Git; the six small master-data files and manifest are committed.

The pack has 50 entity records (45 legal), 40 currencies, 25 hierarchy nodes, 40 accounts, 20 daily GL files of 20,000 rows each, daily spot and four forward tenors for 12 months, and one executed-trade history file per program. Only the matching program's history file is loaded into each tenant. All names and dates are fictional or illustrative. Amounts and rates use `decimal.js` and are written as decimal text. The GL key is entity, account, currency and cost center. Forward points use the configured difference between USD and the base currency's annual interest assumption.

## Planted conditions

| Condition | File/date | Intended stage |
| --- | --- | --- |
| Missing EUR/USD spot and forward curve | `rates/rates-2026-11-12.csv` | Exposure or recommendation rate lookup |
| Stale GBP/USD observation | `rates/rates-2026-11-13.csv`; observed 2026-11-12 16:30 UTC | FX Rate quality flag |
| AUD/USD spot and forward outlier | `rates/rates-2026-11-16.csv`; 25% spot jump | FX Rate quality flag |
| Illustrative EUR holiday in the 3M value-date roll | `calendars.csv` and `rates/rates-2026-11-20.csv`; 2027-02-22 closes, quoted value date 2027-02-23 | Joint calendar/value-date check |
| Late GL file | `gl/gl-2026-10-27.csv`; hold it back in both tenants until after the cycle starts | Cycle waits, then completes after the load and rerun |
| EUR balance sign reversal | `gl/gl-2026-11-19.csv` and `gl/gl-2026-11-20.csv` | Exposure calculation |
| All LE45 balances out of scope | Every GL file and both program mappings | Data Source mapping |
| Forty file-shape errors | `gl-malformed.csv`; row and column list in `packs/uat/expected/gl-malformed-problems.json` | D parser, all or nothing |
| Unknown entity, unknown account, excluded account changes | `gl-dirty.csv`; ten changed rows of each kind | Data Source and Exposure Analysis |

The fixture files have 20,000 data rows each. `gl-malformed.csv` is expected to fail as `INVALID_FILE`, exit 1, with zero rows stored. `gl-dirty.csv` is parser valid; its expected outcome is `APPLIED`. The independent Data Source counts for each program are in `packs/uat/expected/gl-dirty-plants.json`. A loader-backed run must still verify those counts and the Exposure Analysis issues. No database-backed acceptance result is claimed here.

**Resolved by Fikre — excluded-account count.** Data Source's `ingestionStatus` exposes total included, excluded and blocked rows, while `dataQualityIssues` exposes blocked reasons only. UAT compares the service's total excluded count with an independent calculation from the file, account flags and the two programs' mapping rules. The expected-results file records that calculation's exclusion-reason breakdown, including the ten planted non-FX account changes. It does not claim a service count by exclusion reason.
