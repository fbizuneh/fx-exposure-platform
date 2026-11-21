# UAT generator (E3)

Run `npm run uat:generate -- --seed 20261120 --out packs/uat/generated`. The optional `--config` defaults to `packs/uat/config.json`; its `generator` section holds the date range, chart, rate source, initial USD rates, daily volatility in basis points, annual interest assumptions, NDF flags and weekend conventions. The same generated files are loaded into both UAT tenants, one program per tenant. The output manifest records every file's row count and SHA-256 digest. Large generated files are ignored by Git; the six small master-data files and manifest are committed.

The pack has 50 entity records (45 legal), 40 currencies, 25 hierarchy nodes, 40 accounts, 20 daily GL files of 20,000 rows each, daily spot and four forward tenors for 12 months, and an executed-trade history. All names and dates are fictional or illustrative. Amounts and rates use `decimal.js` and are written as decimal text. The GL key is entity, account, currency and cost center. Forward points use the configured difference between USD and the base currency's annual interest assumption.

## Planted conditions

| Condition | File/date | Intended stage |
| --- | --- | --- |
| Missing EUR/USD spot and forward curve | `rates/rates-2026-11-12.csv` | Exposure or recommendation rate lookup |
| Stale GBP/USD observation | `rates/rates-2026-11-13.csv`; observed 2026-11-12 16:30 UTC | FX Rate quality flag |
| AUD/USD spot and forward outlier | `rates/rates-2026-11-16.csv`; 25% spot jump | FX Rate quality flag |
| Illustrative EUR holiday on the 3M value date | `calendars.csv` and `rates/rates-2026-11-20.csv`; 2027-02-22 | Joint calendar/value-date check |
| EUR balance sign reversal | `gl/gl-2026-11-19.csv` and `gl/gl-2026-11-20.csv` | Exposure calculation |
| All LE45 balances out of scope | Every GL file and both program mappings | Data Source mapping |
| Forty file-shape errors | `gl-malformed.csv`; row and column list in `packs/uat/expected/gl-malformed-problems.json` | D parser, all or nothing |
| Unknown entity, unknown account, excluded account changes | `gl-dirty.csv`; ten changed rows of each kind | Data Source and Exposure Analysis |

The fixture files have 20,000 data rows each. `gl-malformed.csv` is expected to fail as `INVALID_FILE`, exit 1, with zero rows stored. `gl-dirty.csv` is parser valid; its expected outcome is `APPLIED`. The exact Data Source and Exposure Analysis quality counts still need a loader-backed run. No database-backed acceptance result is claimed here.

**DECISION REQUIRED — excluded-account issue count.** Data Source's `ingestionStatus` exposes total included, excluded and blocked rows, while `dataQualityIssues` exposes blocked reasons only. It does not expose the number of exclusions caused specifically by an account mapping rule. Options: (1) compare total excluded against the independent file-and-mapping calculation, recording the ten planted account changes separately; this stays within E's scope but does not provide a service count by exclusion reason; (2) add per-reason exclusion counts to Data Source's contract, which provides a direct assertion but changes platform behavior and needs its own owner-reviewed PR. Recommendation: option 1 for Release 1 UAT, with the limit stated in the expected-results file and guide. Fikre's decision is needed before the dirty fixture's final expected counts are asserted.
