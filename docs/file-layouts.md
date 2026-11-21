# File layouts

The CSV layouts the data loaders accept (stream D) and that the UAT pack generates against (stream E). Column order below is the canonical order; headers are matched ignoring case and spaces. One file per kind. Snake_case headers match the row fields in code (release-1 decisions #3, #4, #5, #10).

Batch-level facts (source, as-of date, chart code, business date, mode, program) are **command options**. They are not substituted for columns of the file. A file is a pure table. For GL balances only, an optional per-row `as_of` column may repeat the batch date (see that kind).

## Shared rules

- **Encoding and shape.** UTF-8 text, with or without a byte-order mark. Comma-separated; quotes as in FX Trade's `splitCsv` (a field that contains a comma or quote is wrapped in `"…"`, and a quote inside a field is doubled). Line endings LF or CRLF. Blank lines are skipped. Parser problem `rowNo` values count non-blank data rows from 1 (the header is not a data row; blank lines are not numbered), matching `parseExecutedFile`.
- **Everything is text.** Every cell is read as text. Money and rates are never converted to numbers in the parser: they are passed on exactly as sent. An empty cell is `null`.
- **Booleans.** Only `true` or `false` in lower case; nothing else.
- **Dates and times.** Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 with a `Z` suffix (for example `2026-03-09T16:30:00Z`). Currencies are three upper-case letters.
- **Unknown columns.** An unknown header is an error in every kind except **GL balances** (further columns become dimensions) and **executed trades** (further columns become custom fields, as in the existing `parseExecutedFile`). A typo in a header must not pass silently.
- **All or nothing.** A file with any parser problem stores nothing (decision #4). Service business rules (unknown parent, missing rate, and so on) stay with the owning service.

Suggested file names below are the kind name plus `.csv`. Dated pack files (for example a daily GL file) may use another name; the columns stay the same.

---

## entities (`entities.csv`)

Row type: `EntityRow` in Master Data. Load options: `--source`, `--as-of`, `--mode` (`SNAPSHOT` for full loads, decision #5; or `PARTIAL`).

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `code` | text | yes | Non-empty; no surrounding spaces |
| `name` | text | yes | Non-empty; no surrounding spaces |
| `type` | text | yes | `GROUP`, `REGION`, `LEGAL_ENTITY`, `BUSINESS_UNIT`, `DIVISION`, `PROFIT_CENTER`, `COST_CENTER`, `PROJECT` |
| `parent_code` | text | no | Empty for a root; otherwise an entity `code` in the same file or already on record |
| `country_code` | text | no | Empty, or two upper-case letters |
| `functional_currency` | text | no\* | Empty, or three upper-case letters. \*Required by the service when `type` is `LEGAL_ENTITY` or `is_legal_entity` is `true` |
| `is_legal_entity` | boolean | yes | `true` or `false` |
| `is_treasury_entity` | boolean | yes | `true` or `false` |
| `is_hedge_execution_entity` | boolean | yes | `true` or `false` |

```csv
code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity
G,Acme Group,GROUP,,,,false,false,false
AMER,Americas,REGION,G,,,false,false,false
US1,Acme US Inc,LEGAL_ENTITY,AMER,US,USD,true,true,true
```

---

## hierarchy (`hierarchy.csv`)

Row type: `HierarchyNodeRow` in Master Data. Load options: `--source`, `--as-of`, `--mode`.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `chart_code` | text | yes | Non-empty chart code |
| `code` | text | yes | Non-empty node code within the chart |
| `name` | text | yes | Non-empty |
| `classification` | text | yes | `BALANCE_SHEET`, `ASSETS`, `LIABILITIES`, `EQUITY`, `INCOME_STATEMENT`, `REVENUE`, `COGS`, `OPERATING_EXPENSES`, `OTHER_INCOME_EXPENSE` |
| `parent_code` | text | no | Empty for a root; otherwise a node `code` in the same chart |

```csv
chart_code,code,name,classification,parent_code
MAIN,BS,Balance sheet,BALANCE_SHEET,
MAIN,ASSETS,Assets,ASSETS,BS
MAIN,CASH,Cash and equivalents,ASSETS,ASSETS
```

---

## accounts (`accounts.csv`)

Row type: `AccountRow` in Master Data. Load options: `--source`, `--as-of`, `--mode`.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `chart_code` | text | yes | Non-empty chart code |
| `account_number` | text | yes | Non-empty account number as received |
| `name` | text | yes | Non-empty |
| `statement_type` | text | yes | `BALANCE_SHEET`, `INCOME_STATEMENT`, `CASH_FLOW` |
| `normal_balance` | text | yes | `DEBIT`, `CREDIT` |
| `monetary_flag` | boolean | yes | `true` or `false` |
| `fx_relevant_flag` | boolean | yes | `true` or `false` |
| `hierarchy_node_code` | text | no | Empty, or a hierarchy node `code` in the same chart |

```csv
chart_code,account_number,name,statement_type,normal_balance,monetary_flag,fx_relevant_flag,hierarchy_node_code
MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,CASH
MAIN,1200,Trade receivables,BALANCE_SHEET,DEBIT,true,true,ASSETS
MAIN,1500,Inventory,BALANCE_SHEET,DEBIT,true,false,ASSETS
```

---

## currencies (`currencies.csv`)

Row type: `CurrencyRow` in Master Data. Load options: `--source`, `--as-of`, `--mode`.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `code` | text | yes | Three upper-case letters |
| `is_ndf` | boolean | yes | `true` or `false` |

```csv
code,is_ndf
USD,false
EUR,false
BRL,true
```

---

## calendars (`calendars.csv`)

Row type: `CalendarRow` in Master Data (decision 0014). The file is one row per holiday; the parser groups by currency. Load options: `--source`, `--as-of`, `--mode`.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `currency_code` | text | yes | Three upper-case letters |
| `weekend_days` | text | yes | Zero to three values from `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`, separated by `\|` (for example `SAT\|SUN`); empty means no weekend days. Master Data refuses more than three (`validateCalendars`). Every row of one currency must repeat the same value |
| `covered_through` | date | yes | `YYYY-MM-DD`. Every row of one currency must repeat the same value. Holidays must not fall after it |
| `holiday_date` | date | no | `YYYY-MM-DD`, or empty when the currency has no holidays |
| `holiday_name` | text | no | Empty, or a non-blank name for that holiday |

A currency with no holidays has **one** row with empty `holiday_date` and `holiday_name`. The parser refuses a currency whose rows disagree on `weekend_days` or `covered_through`.

```csv
currency_code,weekend_days,covered_through,holiday_date,holiday_name
USD,SAT|SUN,2027-12-31,2026-01-01,New Year's Day
USD,SAT|SUN,2027-12-31,2026-07-04,Independence Day
AED,FRI|SAT,2027-12-31,,
```

---

## exposure currencies (`exposure-currencies.csv`)

Row type: `PairExposureCurrencyRow` in Master Data (decision 0015). Load options: `--source`, `--as-of`, `--mode`, and **`--program` (required)** — the hedging program these mappings belong to. The program is never a column.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `pair` | text | yes | Two different three-letter currencies joined by `-` (either order; stored alphabetical, so `GBP-EUR` and `EUR-GBP` are the same pair) |
| `exposure_currency` | text | yes | Three upper-case letters; must be one of the pair |

```csv
pair,exposure_currency
EUR-USD,USD
GBP-USD,USD
USD-BRL,USD
```

---

## GL balances (`gl.csv`)

Row type: `GlBalanceRow` in Data Source. Load options: `--chart`, `--as-of`, `--source` (**all required**). Chart and source are never columns. **`--as-of` is required and sets the batch date. A GL row’s `as_of` is optional; if supplied, it must match `--as-of`.**

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `entity_code` | text | yes | Non-empty entity code |
| `account_number` | text | yes | Non-empty account number |
| `currency` | text | yes | Three upper-case letters |
| `balance` | money (text) | conditional | Signed decimal text. Send **either** `balance` **or** debit/credit, never both and never neither |
| `debit` | money (text) | conditional | Non-negative decimal text when used with `credit` instead of `balance` |
| `credit` | money (text) | conditional | Non-negative decimal text when used with `debit` instead of `balance` |
| `as_of` | date | no | Empty, or `YYYY-MM-DD` equal to the batch `--as-of` |
| *(any further column)* | text | no | Becomes a dimension (name → value). Unknown to the fixed list above is not an error here |

```csv
entity_code,account_number,currency,balance,debit,credit,as_of,cost_center
US1,1000,USD,125000.50,,,2026-03-09,CC-100
US1,1200,EUR,,10000.00,0.00,2026-03-09,CC-100
DE1,2000,EUR,-4200.00,,,2026-03-09,
```

---

## FX rates (`rates.csv`)

Row type: `RateRow` in FX Rate. Load options: `--source`, `--business-date` (**both required**). Source and business date are never columns.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `base` | text | yes | Three upper-case letters; must differ from `quote` |
| `quote` | text | yes | Three upper-case letters |
| `type` | text | yes | `SPOT` or `FORWARD` |
| `tenor` | text | yes | `SPOT` when `type` is `SPOT`; otherwise a tenor code such as `1W`, `1M`, `3M`, `6M`, `12M` |
| `value_date` | date | no | Empty for spot; `YYYY-MM-DD` when given |
| `all_in` | rate (text) | yes | Positive decimal text (at most 10 places) |
| `spot` | rate (text) | no | Empty for spot rows; positive decimal text for forwards when supplied |
| `forward_points` | rate (text) | no | Empty for spot rows; signed decimal text for forwards when supplied |
| `bid` | rate (text) | no | Empty, or positive decimal text |
| `mid` | rate (text) | no | Empty, or positive decimal text |
| `ask` | rate (text) | no | Empty, or positive decimal text |
| `observed_at` | timestamp | yes | ISO 8601 with `Z` |

A spot row must not carry a value date, spot or forward points. Service validation (not the column list) also checks that spot plus forward points equals the all-in rate when all three are present.

```csv
base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at
EUR,USD,SPOT,SPOT,,1.0850000000,,,1.0849000000,1.0850000000,1.0851000000,2026-03-09T16:30:00Z
GBP,USD,SPOT,SPOT,,1.2700000000,,,,,,2026-03-09T16:30:00Z
EUR,USD,FORWARD,3M,2026-06-09,1.0900000000,1.0850000000,0.0050000000,,,,2026-03-09T16:30:00Z
```

---

## executed trades (`executed.csv`)

Existing layout in `services/fx-trade/src/file.ts` (`ExecutedRow`, `parseExecutedFile`). Import command: `importExecutedTrades`. No load options beyond the common ones (`--tenant`, and so on). Further columns become **custom fields** (decision 0009), not an error.

| Column | Type | Required? | Allowed values |
| --- | --- | --- | --- |
| `trade_id` | text | yes | Non-empty; with `execution_platform_id` identifies the trade |
| `execution_platform_id` | text | yes | Non-empty platform id |
| `trading_entity` | text | yes | Entity code (must be a hedge-execution entity on the trade date) |
| `counterparty` | text | no | Empty, or counterparty name |
| `trade_date` | date | yes | `YYYY-MM-DD` |
| `value_date` | date | yes | `YYYY-MM-DD` |
| `deal_currency` | text | yes | Three upper-case letters |
| `deal_amount` | money (text) | yes | Positive decimal text (up to 4 places) |
| `settlement_currency` | text | yes | Three upper-case letters; differs from deal currency |
| `settlement_amount` | money (text) | yes | Positive decimal text (up to 4 places) |
| `fixing_date` | date | no | Empty, or `YYYY-MM-DD` (required by the service for NDF) |
| `instrument` | text | yes | `SPOT`, `FORWARD`, `NDF`, `SWAP` |
| `buy_sell` | text | yes | `BUY` or `SELL` (case folded on import) |
| `portfolio` | text | no | Empty, or portfolio code |
| `hedging_program_id` | text | no | Empty, or a program id (unknown or empty stays unmatched) |
| `pre_trade_reference` | text | no | Empty, or the echoed `PT-` reference |
| `leg` | text | no | Empty or `SINGLE` for a one-leg trade; `NEAR` and `FAR` for the two rows of a swap |
| *(any further column)* | text | no | Stored as a custom field when the cell is non-empty |

A swap arrives as two rows with the same `trade_id` and `execution_platform_id`, one `NEAR` and one `FAR`.

```csv
trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,portfolio,hedging_program_id,pre_trade_reference,leg
SIM-2026-03-09-1,SIMFX,US1,Nordic Demo Bank,2026-03-09,2026-06-09,EUR,1000000.0000,USD,1090000.0000,,FORWARD,BUY,BOOK-A,BS-ENT,PT-A1B2C3D4E5F6,
SIM-2026-03-09-2,SIMFX,US1,Alpine Demo Bank,2026-03-09,2026-03-11,USD,500000.0000,BRL,2750000.0000,2026-03-09,NDF,SELL,BOOK-A,BS-ENT,PT-G7H8I9J0K1L2,
SIM-2026-03-09-3,SIMFX,US1,Nordic Demo Bank,2026-03-09,2026-03-11,EUR,250000.0000,USD,271250.0000,,SPOT,BUY,BOOK-A,BS-ENT,PT-M3N4O5P6Q7R8,
```

---

## Load options by kind (not columns)

| Kind | Options |
| --- | --- |
| entities, hierarchy, accounts, currencies, calendars | `--source`, `--as-of`, `--mode` |
| exposure currencies | same, plus `--program` (required) |
| GL balances | `--chart`, `--as-of`, `--source` (all required) |
| FX rates | `--source`, `--business-date` (both required) |
| executed trades | none beyond the common CLI options |

Common to the loader CLI (stream D, later): `--tenant`, and typically `--by`. See `docs/release-1/D-data-loaders.md`.
