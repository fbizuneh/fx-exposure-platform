# 0023 Runtime: one server process

Date: 2026-11-20. Status: built (workstream A of Release 1). Sources: decisions 0001 (platform role), 0019 (delivery and retry), AGENTS.md (one deployable), the Release 1 work instructions.

## Decided
1. **One process.** `npm run start` runs `app/src/server.ts`: it reads the settings, migrates the database, builds the services (`composeApp`), starts an HTTP server and two timer loops, and stops cleanly on SIGTERM or SIGINT. `TIMER_ENABLED=false` runs a process without the loops. Running two instances with the loops on is **not supported** in Release 1; there is no leader election.
2. **Settings from the environment**, all checked at start and reported together: `DATABASE_URL` (required), `PORT` (8080), `MIGRATE_ON_START` (true), `TIMER_ENABLED` (true), `DELIVERY_INTERVAL_SECONDS` (5), `CYCLE_CHECK_INTERVAL_SECONDS` (60), `PLATFORM_TIMEZONE` (UTC), `LOG_LEVEL` (info).
3. **Two loops that never overlap themselves.** Delivery calls `drain` every few seconds; the cycle loop calls `startDueCycles` for each active tenant. A pass that starts while the last is running is skipped and counted. An error in a pass is logged and the loop carries on. One tenant failing in the cycle loop does not stop the others.
4. **Tenants are listed by Identity.** `activeTenants()` is a platform-level question on Identity's contract: the IDs of active tenants, oldest first. Only the runtime asks it.
5. **The scheduler is a real platform user.** The old `SCHEDULER` constant held an ID that is not a UUID, so starting a cycle with it failed against a real database (the tests had always used an admin). The runtime now calls `ensurePlatformUser({ issuer: "platform", externalSubject: "scheduler" })` at start and uses that user. `ensurePlatformUser` makes the user once and returns the same one after; a disabled one stays disabled and is not re-enabled. Each cycle it starts is therefore a recorded use of the platform role (decision 0001).
6. **The date a cycle starts on is today in `PLATFORM_TIMEZONE`** (default UTC), one setting for the whole deployment. A time zone per tenant is a later change.
7. **Health.** `GET /healthz` is 200 whenever the process is up. `GET /readyz` is 200 only when the database answers and every migration file of every service is recorded as applied; otherwise 503 with a reason. `GET /status` gives version, uptime, the last delivery and cycle passes, skipped passes and the counts of events waiting to retry and stuck: **counts only**, no tenant names, event contents or row data. Until sign-in exists (workstream C), `/status` and `/readyz` are for the operator network only. The server uses `node:http` and takes extra routes, so the API (workstream B) can add its own.
8. **Logging.** One JSON object per line on standard output. Row contents, amounts, file text and credentials are never logged; fields named like a password, token, secret, cookie or authorization are replaced by `[redacted]`.
9. **Shutdown.** Stop the timers, wait up to 20 seconds for a running pass, close the HTTP server and the database connections, exit 0. A second signal exits at once.

## Measured (volume test, `VOLUME_TEST=1`)
One tenant, 45 legal entities (50 entity records), 40 currencies, one batch of 20,000 GL balance rows, driven by the runtime's own ticks, on a local PostgreSQL 16: master data 0.1 s, rates 0.03 s, the 20,000-row batch 0.8 s, delivery and cycle start under 0.05 s, run to completion 2.2 s.

## Not built
The API, sign-in, container image and deploy, alerts for stuck events, and any per-tenant time zone.
