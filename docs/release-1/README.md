# Release 1 work instructions: A, D, E and J

Four workstreams can start now, in parallel, each in its own file: A Runtime (built, PR #16), D Data loaders, E UAT data and configuration pack, J Backend gaps. Each file is written so one programmer can work from it without asking what was meant, and each ends with the checks that say it is done.

Start with AGENTS.md and docs/STATUS.md, then this page, then your stream's file.

| Stream | File | Starts | Can run alongside | Hands over |
| --- | --- | --- | --- | --- |
| A Runtime | [A-runtime.md](A-runtime.md) | Built | | A running server that B (API), C (sign-in) and H (environment) build on |
| D Data loaders | [D-data-loaders.md](D-data-loaders.md) | Now | A, E, J | Nine file layouts and a loader command that E's files must follow |
| E UAT data and configuration pack | [E-uat-data.md](E-uat-data.md) | Data design now; files once D1 is merged | A, J | The data set that I (UAT readiness) runs against |
| J Backend gaps | [J-backend-gaps.md](J-backend-gaps.md) | Now | A, D, E | Control totals, wider audit coverage, operator handling of stuck events |

## Already decided

- UAT users work in a browser. Release 1 runs as one deployable on one PostgreSQL database.
- Data is GL balances only. Files use the application's own layouts; mapping a customer's native ERP layout is deferred.
- Sign-in uses an identity provider (OIDC), with Keycloak run locally for UAT.
- UAT size: 20,000 GL balance rows per cycle, 50 entities, 40 currencies.

## Rules for every workstream

These come from AGENTS.md and docs/STATUS.md. Read both before writing code, then the README of every service you touch and the decision records it names.

**Working**

1. Work on a branch and open a PR. `main` is protected: a PR, one independent approval and a passing `verify` check. Never push to `main`, and never approve or merge your own PR; Fikre merges.
2. Keep each PR to one task from your file. Do what the task says and nothing more; note other problems in the PR description instead of fixing them.
3. If a choice is not settled in docs/design, docs/decisions or your file, stop and write a DECISION REQUIRED block: the options, your recommendation, and what each costs. Do not guess.
4. Each task that makes a design choice gets a numbered decision record in docs/decisions (the next free number), written before the code.
5. Update docs/STATUS.md and the README of any service you change when you finish. AGENTS.md and service READMEs stay at 60 lines or fewer; the `contract` check enforces it.

**Boundaries (the build fails if rules 1 to 6 are broken)**

1. Own your schema: only the owning service touches its tables and holds its migrations. Schema changes are migrations in that service, never a sync from code.
2. Ask, never join: reach another service only through `@services/<name>/contract`, never its `src/`.
3. No foreign keys across schemas. Every table has `tenant_id`; program-scoped tables also have `program_id` and carry the `-- program-scoped` marker.
4. Announce changes through the service's outbox. Every receiver must be safe to repeat.
5. No transaction spans two services: use two steps and an event.
6. Money and rates use `decimal.js`, never floating point. Numbers arrive as text and stay text until they are calculated.
7. An approved cycle is never changed. A correction starts a new cycle.

**Code**

- TypeScript on Node 22 type stripping: `import type` for types, `.ts` extensions in imports, no parameter properties, `import { Decimal } from "decimal.js"`.
- Do not write text such as `identity.` in code where it could be read as another service's schema; the schema check flags it.

**Proving it works**

- Database tests need `TEST_DATABASE_URL` (a database whose name ends in `_test`; `docker compose up -d` gives one). Without it they are skipped, and a skipped test is not a pass.
- Every new rule gets a test that fails when the rule is broken: change the code, watch the test fail, put it back.
- Before opening the PR run `npx tsc --noEmit`, `npm run check` and `npm test`. Never say a check passed unless you ran it, and say which ones you ran.

**Reporting**

Finish the PR description with: what changed, which checks ran and their result, and what is left.

## UAT size target and hand-off order

**Size target.** One tenant, 50 entities, 40 currencies, and 20,000 GL balance rows in a daily batch. A, D, E and J must each prove their part at this size, not only on test-sized data:

- D loads a 20,000-row GL file in one batch in under 60 seconds on the UAT database, and rejects a bad file without partial writes.
- E's data set holds exactly this size in every daily GL file, with 20 business days of GL history and 12 months of rates and executed trades, so a cycle, a rerun and a comparison with the prior cycle all work.
- A runs a whole cycle at this size without a timer tick overlapping itself (measured in PR #16: about 3 seconds locally).
- J's control totals add up over all 20,000 rows and 40 currencies.

**Order of hand-over**

1. D step D1 (file layouts agreed and written down) and E steps E1 and E2 (data design, configuration) start together. E's files cannot be generated until the layouts are fixed. E5 (the simulator) can start at once.
2. D steps D2 to D6, and J run fully in parallel from day one. They touch different directories, apart from `docs/STATUS.md` and, in J, the Audit, Data Source and Identity contracts. D7 waits for J1.
3. E step E3 (generate the files) starts when D step D1 is merged. E step E7 (the rehearsal, which loads the pack) needs D's loaders, A's server and J, and is the first point where all four streams meet.
4. When all four are merged, one person runs `npm run uat:rehearse` (E7). It is the acceptance test for the four streams together.

**Merge conflicts to expect**: `docs/STATUS.md` (everyone) and `app/src/` (A and D). Rebase onto `main` before opening the PR and keep STATUS edits to the lines about your own stream.

## Decisions to confirm before work starts

Each has a recommendation. A programmer who meets one of these unconfirmed writes a DECISION REQUIRED block instead of choosing. Rows 1 and 2 are built (decision 0023, PR #16).

| # | Stream | Decision | Recommendation |
| --- | --- | --- | --- |
| 1 | A | One process or a separate worker for the timer loop | One process. The server starts the timer loop in the same process; a setting turns it off for a second instance. |
| 2 | A | How the timer loop finds tenants | A platform-level question on Identity's contract, `activeTenants()`. |
| 3 | D | Where the parsers live | Each parser in its owning service (as FX Trade already does), exported from the service entry point; the command-line loader in `app/` calls them. |
| 4 | D | File shape | One CSV per data kind, snake_case headers matching the row fields in the code: nine kinds in all (six master-data kinds, GL balances, rates, executed trades). A bad row stops the file and nothing is stored (all or nothing); errors give row numbers. |
| 5 | D | Master data load mode | SNAPSHOT for full loads. The existing safeguard that holds a snapshot ending too many records stays on. |
| 6 | J | Control total definition | Data Source answers a per-batch, per-currency question: rows and sum of signed amounts received, and the same for included, excluded and blocked rows. A batch may also carry the sender's expected totals (currency, row count, sum); any difference refuses the batch. |
| 7 | J | Audit for Data Source and Exposure Analysis | Record batch loaded (by a person), mapping rule added, mapping rule ended. For Exposure Analysis, record only commands a person can call that change what the next run shows; if there are none, record nothing and say so. Automated runs and connector feeds stay unrecorded, as in decision 0012. |
| 8 | J | Who may retry a stuck event | New permission `operations:manage-events`, held by TREASURY_ADMIN for that tenant's events and by the platform role for all tenants. Every retry is written to Audit. Skipping or discarding an event stays out of scope. |
| 9 | E | Which program types the UAT tenant uses | Two balance sheet programs on the same GL, since GL balances are the only data type in Release 1: `BS-ENT` (daily, ENTITY netting) and `BS-REG` (weekly, REGION netting). Hedge policy is hedge-ratio-adjustment with an amount-threshold override on one pair; one program rolls (Adjust + Swap), the other does not. |
