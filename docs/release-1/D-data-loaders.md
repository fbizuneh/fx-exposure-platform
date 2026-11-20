# D. Data loaders

## Purpose

Master Data, Data Source, FX Rate and FX Trade take their data through commands, and only FX Trade can read a file today (`parseExecutedFile`). UAT users and E's data pack need a way to put files in. This task builds the file layouts, one parser per kind, and one command-line loader. The loader's functions are written so B's upload endpoint can call the same code later.

**Needs nothing first. Runs in parallel with A, E and J. Step D1 is the hand-over that E waits for.**

## Read first

- `services/master-data/src/rows.ts` (row types) and `apply.ts` (`Submission`, modes SNAPSHOT and PARTIAL, `ChangeSetRefused`, the safeguard that holds a snapshot that ends too many records, `SubmitResult` with status APPLIED, HELD or DUPLICATE).
- `services/data-source/src/rows.ts` (`GlBalanceRow`) and `intake.ts` (`GlBatch`, `BatchResult`, `BatchRefused`).
- `services/fx-rate/src/rows.ts` (`RateRow`) and `load.ts` (`RateLoad`, `LoadResult`, `RatesInvalid`).
- `services/fx-trade/src/file.ts` (`splitCsv`, `parseExecutedFile`, `ExecutedRow`, `toPreTradeFile`, `OUT_HEADER`) and `import.ts` (the import command and `ImportResult`). **Read the command's real name there; do not assume it.**
- `docs/decisions/0014` (calendars) and `0015` (exposure currency per pair).

## Decisions this task relies on

Overview table (README) **#3** (parsers live in the owning service), **#4** (one CSV per kind, snake_case headers, all or nothing), **#5** (SNAPSHOT for full loads) and **#10** (a CSV reader in each service). Write the layouts below as the starting point of D1 and change them only with Fikre's agreement.

## Steps

### D1. Write down the layouts (merge this first)

New file `docs/file-layouts.md`: for each kind, the file name, every column with type, whether required, allowed values, and a 3-row example. This is the contract E generates files against, so it merges alone and early. Start from this:

| Kind | Columns (in this order; headers are matched ignoring case and spaces) | Load options |
| --- | --- | --- |
| entities | `code`, `name`, `type`, `parent_code`, `country_code`, `functional_currency`, `is_legal_entity`, `is_treasury_entity`, `is_hedge_execution_entity` | `--source`, `--as-of`, `--mode` |
| hierarchy | `chart_code`, `code`, `name`, `classification`, `parent_code` | same |
| accounts | `chart_code`, `account_number`, `name`, `statement_type`, `normal_balance`, `monetary_flag`, `fx_relevant_flag`, `hierarchy_node_code` | same |
| currencies | `code`, `is_ndf` | same |
| calendars | `currency_code`, `weekend_days`, `covered_through`, `holiday_date`, `holiday_name` | same |
| exposure currencies | `pair`, `exposure_currency` | same, plus `--program` (required) |
| GL balances | `entity_code`, `account_number`, `currency`, `balance`, `debit`, `credit`, `as_of`; any further column becomes a dimension | `--chart`, `--as-of`, `--source` (all required) |
| FX rates | `base`, `quote`, `type`, `tenor`, `value_date`, `all_in`, `spot`, `forward_points`, `bid`, `mid`, `ask`, `observed_at` | `--source`, `--business-date` (both required) |
| executed trades | the existing layout in `file.ts` (`trade_id`, `execution_platform_id`, `trading_entity`, `counterparty`, `trade_date`, `value_date`, `deal_currency`, `deal_amount`, `settlement_currency`, `settlement_amount`, `fixing_date`, `instrument`, `buy_sell`, `portfolio`, `hedging_program_id`, `pre_trade_reference`, `leg`) | none beyond the common ones |

Rules to write into the document:

- Text files in UTF-8 with or without a byte-order mark; commas; quotes as in `splitCsv`; LF or CRLF; blank lines skipped.
- Every value is read as text. Money and rates are never converted to numbers in the parser: they are passed on as text exactly as sent. An empty cell is `null`.
- Booleans are `true` or `false` in lower case, nothing else. Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 with `Z`. Currencies are three upper-case letters.
- Calendars: every row of one currency repeats `weekend_days` (days written as in the `Weekday` type of Master Data's contract, separated by `|`) and `covered_through`, and the parser refuses a currency whose rows disagree. A currency with no holidays has one row with empty holiday columns.
- Unknown columns are an error in every kind except GL balances, where they become dimensions. A typo in a header must not pass silently.
- The batch-level facts (source, as-of date, chart code, business date, mode, program) are command options, never columns, so a file is a pure table.

Done when: the document is merged and Fikre has said the layouts are agreed. **E step E3 starts from this.**

### D2. A CSV reader in each service (decided: option A)

`splitCsv` is in FX Trade (`services/fx-trade/src/file.ts`). Master Data, Data Source and FX Rate need the same reader, and a service cannot import another service's `src/`. `shared/kernel` is reserved for the seven identifiers (AGENTS.md), so the reader does not go there. Fikre chose option A on 2026-11-20 (README row #10): each of the four services that read files keeps its own small `csv.ts`.

1. Copy FX Trade's reader and its tests into `services/master-data/src/csv.ts`, `services/data-source/src/csv.ts` and `services/fx-rate/src/csv.ts`, one commit per service. FX Trade keeps its own, unchanged. Do not import across services.
2. Give every copy the same test cases (quoted commas, escaped quotes, CRLF and LF, byte-order mark, blank lines, a trailing newline), so drift shows up as a failing test.
3. Put a one-line comment at the top of each copy: it is one of four copies and a change is made in all four.
4. Write a short decision record (the next free number) stating the choice and its cost.

Done when the three copies and the record are merged and the existing FX Trade tests pass untouched.

### D3. Parsers, one per kind, no database

Each parser is a pure function from text to a result:

```
parseXFile(text): { rows: Row[]; problems: { rowNo: number | null; column: string | null; message: string }[] }
```

Use the service's own `csv.ts` from D2. Place and name the parsers: `services/master-data/src/files.ts` (`parseEntitiesFile`, `parseHierarchyFile`, `parseAccountsFile`, `parseCurrenciesFile`, `parseCalendarsFile`, `parseExposureCurrenciesFile`), `services/data-source/src/file.ts` (`parseGlFile`), `services/fx-rate/src/file.ts` (`parseRatesFile`). Export each from its service's entry point. The executed-trade parser already exists.

Rules for all of them:

- A missing required column, a duplicate column, or an unknown column (see D1) is one problem with `rowNo: null`.
- Every bad value is one problem with its row number (data rows counted from 1, as `parseExecutedFile` does) and column. Collect all problems; do not stop at the first.
- The parser checks shape only (type, format, allowed values, presence). Business rules (an unknown parent, a pair with no rate) stay with the service, which already enforces them. Do not copy those rules into the parser.
- GL rows: if `balance` is given, `debit` and `credit` must be empty and the reverse; a row with both or neither is a problem. (Check what `intake.ts` already refuses so you do not contradict it.)
- Speed: 20,000 GL rows parse in under 2 seconds.

Done when: for each parser there are tests for a valid file, a file with a byte-order mark and CRLF, quoted commas, blank lines, each kind of problem above, and the 20,000-row speed. For every rule, change the code to break it and watch a test fail.

### D4. Loader functions in `app/`

New folder `app/src/loaders/`, one function per kind, for example:

```
loadGlFile(app, { tenantId, text, chartCode, asOf, sourceSystem, by }): Promise<LoadOutcome>
```

Each one parses; if there are any problems it returns them without calling the service (**all or nothing**); otherwise it calls the owning service's command and returns the service's result. A service refusal (`BatchRefused`, `ChangeSetRefused`, `RatesInvalid`) is returned as a refusal with the service's message, not thrown. Functions import the services only through their entry points and contracts. They never write to a service's tables.

`LoadOutcome` is one of: `{ kind: "INVALID_FILE", problems }`, `{ kind: "REFUSED", message }`, `{ kind: "HELD", batchId, reason }` (Master Data snapshot safeguard), `{ kind: "DONE", status: "APPLIED" | "DUPLICATE", counts }` where `counts` is the service's own result numbers.

### D5. The command-line loader

`npm run load -- <kind> <file> --tenant <id> [options]` in `app/src/cli/load.ts`, a thin shell over D4. Kinds: `entities`, `hierarchy`, `accounts`, `currencies`, `calendars`, `exposure-currencies`, `gl`, `rates`, `executed`.

- Settings: `DATABASE_URL` from the environment. `--by` defaults to `cli:<operating-system user>`.
- `--dry-run` parses and checks the file only, with no database use.
- `--drain` delivers the resulting events once before exiting (for loading a pack when no server is running). Without it the CLI leaves delivery to the runtime (stream A's server).
- Output: one summary line, then problems, 50 at most then "and N more". **Never print row contents**; print row number, column and message.
- Exit codes: 0 applied or duplicate, 1 invalid file, 2 refused by the service, 3 other error, 4 held for review.
- Loading the same file twice is a normal `DUPLICATE`, exit 0.

### D6. Tests that run the whole path

Database tests through `composeApp`, one per loader: a valid file stores what it should; the same file again is `DUPLICATE`; a file with one bad row stores nothing and names the row; a refusal from the service is reported as `REFUSED` and nothing is stored; a CLI test runs the command as a child process and checks the exit codes. One test loads a generated 20,000-row GL file and checks the time is under 60 seconds. Two fixtures from E3 are used, and they must stay separate: the **malformed** GL file (parser refusal: expect `INVALID_FILE`, exit 1, every planted problem named by row and column, **no rows stored**) and the **parser-valid dirty** GL file (every row is accepted by the loader and stored; the service-level issues it contains are checked in E's rehearsal, not here). **If it is slower, do not tune Data Source here: report the stage and open an issue.** (Stream A measured a 20,000-row batch through `submitGlBatch` at about 0.8 seconds locally, so parsing and the file path are what this test adds.)

### D7. Control-total option (last, after J's task J1 merges)

When `GlBatch` gains `expectedTotals` (task J1), add `--control <file>` to the GL load: a small CSV with columns `currency`, `row_count`, `sum`, passed on as the expected totals. Until J1 is merged, leave this out.

## Not in this task

ERP-native layouts and mapping from them; any other data type than the four above (forecasts, budgets, bank balances); the upload screen and API (B and F); connectors that pull from a system; changes to any service's validation rules.

## Done when

1. D1 merged and agreed; D2 to D6 merged (D7 when J1 is in), with a decision record covering #3, #4 and #5.
2. A file of each kind loads from the command line against a fresh database, and a bad file stores nothing.
3. `npx tsc --noEmit`, `npm run check`, `npm test` pass, and the speed numbers are in the PR.
4. Each touched service README (60 lines or fewer) lists its file parser; `docs/STATUS.md` is updated.
