# app

The one deployable. It wires the services together, delivers events between them, and runs as one server process. It contains no service logic and no migrations. Decision 0023.

## Run
`DATABASE_URL=postgres://... npm run start`. It migrates the database, starts the HTTP server and the two timer loops, and stops cleanly on SIGTERM or SIGINT.

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
- `compose.ts`: builds every service over one database. `dispatch.ts`: `drain` (delivers events), `deliveryProblems`, `retryStuckEvent`, `startDueCycles`.
- `loaders/`: one function per file kind (entities, hierarchy, accounts, currencies, calendars, exposure currencies, GL, rates, executed). Each parses, returns `INVALID_FILE` without calling the service when the file has problems, otherwise calls the owning service command and maps refusals and results to `LoadOutcome`.
- `config.ts`, `log.ts`: settings and JSON logging (no row contents, secrets redacted).
- `ticks.ts`: the two passes and the loop that never overlaps itself. `runtime.ts`: starts and stops everything. `http.ts`, `ready.ts`, `server.ts`: routes, readiness, entry point.

## Not supported in Release 1
Two instances with the timers on (no leader election). Use `TIMER_ENABLED=false` for any extra instance.

## Tests
`end-to-end.db.test.ts` runs a cycle through the real services. `runtime.db.test.ts` tests start-up, the routes, both loops and shutdown. `volume.db.test.ts` (set `VOLUME_TEST=1`) runs 20,000 rows over 50 entities and 40 currencies and prints timings. Database tests need `TEST_DATABASE_URL` (a name ending in `_test`).
