# app

The one deployable. It wires the services together, delivers events between them, and runs as one server process. It contains no service logic and no migrations. Decision 0023.

## Run
`DATABASE_URL=postgres://... npm run start`. It migrates the database, starts the HTTP server and the two timer loops, and stops cleanly on SIGTERM or SIGINT.

`DATABASE_URL=postgres://... npm run load -- <kind> <file> --tenant <id> [options]` loads one CSV through the D4 loaders (`app/src/cli/load.ts`). Kinds: `entities`, `hierarchy`, `accounts`, `currencies`, `calendars`, `exposure-currencies`, `gl`, `rates`, `executed`. `--by` defaults to `cli:<os user>`. `--dry-run` parses only (no database). `--drain` delivers events once before exit; if any of this tenant's events are still pending or failed for retry, exit is 3 and the summary says the load committed but delivery did not finish (Decision 0019). For `gl` only, `--control <file>` passes a CSV of `currency`, `row_count`, `sum` as `expectedTotals` (D7 / decision 0031); `--dry-run` checks the control file's shape only, not whether the totals match the GL file. Refusals print a safe summary only (no row values or amounts); a control-totals mismatch is `REFUSED (control totals do not match)` with the per-currency numbers kept on the FAILED batch. Exit codes: 0 applied/duplicate, 1 invalid file, 2 refused, 3 other (including incomplete delivery), 4 held.

## Settings (environment)
| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `PORT` | 8080 | HTTP port |
| `MIGRATE_ON_START` | true | migrate before serving |
| `TIMER_ENABLED` | true | run the loops in this process |
| `DELIVERY_INTERVAL_SECONDS` | 5 | how often events are delivered |
| `CYCLE_CHECK_INTERVAL_SECONDS` | 60 | how often due cycles are started |
| `PLATFORM_TIMEZONE` | UTC | decides today's date for starting cycles |
| `LOG_LEVEL` | info | debug, info, warn, error |

## Routes
`GET /healthz` (process is up), `GET /readyz` (database answers and every migration is applied; 503 otherwise), `GET /status` (counts only: last passes, skipped passes, events waiting or stuck). Until sign-in exists these are for the operator network only.

## Files
- `compose.ts`: builds every service over one database. `dispatch.ts`: `drain` (delivers events), `deliveryProblems`, `retryStuckEvent`, `startDueCycles`. These are unguarded primitives.
- `operations.ts`: the guarded operator functions over `dispatch.ts` (decision 0030) — `listDeliveryProblems`, `deliveryProblemSummary`, `retryDeliveryProblem` — each checking `operations:manage-events` (TREASURY_ADMIN for their own tenant, the platform role for every tenant). A retry's `event.retried` announcement is written by the retried event's own service, atomically with the reset (every service's `outbox.ts`), not by `app/` after the fact, so the two cannot come apart.
- `loaders/`: one function per file kind (entities, hierarchy, accounts, currencies, calendars, exposure currencies, GL, rates, executed). Each parses, returns `INVALID_FILE` without calling the service when the file has problems, otherwise calls the owning service command and maps refusals and results to `LoadOutcome`.
- `cli/load.ts`: command-line shell over the loaders (`npm run load`).
- `config.ts`, `log.ts`: settings and JSON logging (no row contents, secrets redacted).
- `ticks.ts`: the two passes and the loop that never overlaps itself. `runtime.ts`: starts and stops everything. `http.ts`, `ready.ts`, `server.ts`: routes, readiness, entry point.

## Not supported in Release 1
Two instances with the timers on (no leader election). Use `TIMER_ENABLED=false` for any extra instance.

## Tests
`end-to-end.db.test.ts` runs a cycle through the real services. `operations.db.test.ts` tests the guarded stuck-event functions (access, tenant isolation, audit records). `runtime.db.test.ts` tests start-up, the routes, both loops and shutdown. `volume.db.test.ts` (set `VOLUME_TEST=1`) runs 20,000 rows over 50 entities and 40 currencies and prints timings. `loaders/loaders.db.test.ts` (D6) runs each loader through `composeApp` (valid / DUPLICATE / INVALID_FILE / REFUSED), CLI child-process exit codes, a 20,000-row GL load under 60 seconds, and E3-equivalent malformed/dirty GL fixtures. Database tests need `TEST_DATABASE_URL` (a name ending in `_test`).
