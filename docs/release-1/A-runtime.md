# A. Runtime: one server process

**Status: built.** PR #16, decision 0023, `app/README.md`. Nothing is left to do in this stream except what that PR's review asks for.

## What exists

`npm run start` runs `app/src/server.ts`: it reads the settings (`app/src/config.ts`), migrates the database, builds the services, serves `/healthz`, `/readyz` and `/status` (`app/src/http.ts`, `ready.ts`), runs a delivery loop and a due-cycle loop that never overlap themselves (`app/src/ticks.ts`), logs JSON lines without row contents (`log.ts`), and stops cleanly on SIGTERM or SIGINT (`runtime.ts`).

## What other streams need to know

- Identity gained `activeTenants()` (contract) and `ensurePlatformUser()` (command). The scheduler is a real platform user, so every scheduled cycle start is a recorded platform-role use.
- `createHttpServer(deps)` takes extra routes: the API (stream B) adds its routes there.
- `/status` and `/readyz` have no sign-in until stream C. Running two instances with the timers on is not supported in Release 1; use `TIMER_ENABLED=false` for any extra instance.
- Volume (`VOLUME_TEST=1 node --test app/src/volume.db.test.ts`): 20,000 GL rows over 45 legal entities and 40 currencies completed through the loops in about 3 seconds on a local PostgreSQL 16. Stream E's rehearsal (E7) repeats this with its own data.

## Not in this stream

The HTTP API (B), sign-in (C), screens (F), the container image and deploy (H), alerts for stuck events, a time zone per tenant.
