# FX Exposure Platform

Start with docs/STATUS.md for where the build stands.

## Ownership
Claude is the primary owner: it designs with the product owner (Fikre),
builds every service, and maintains code, tests, checks and docs. Other
programmers contribute under the same rules; the owner reviews against
docs/design and docs/decisions. Keep docs/STATUS.md current.

## Changes to main
main is protected: a PR, one independent approval, a passing `verify` check.
Work on a branch and open a PR; never push to main. The owner merges with the
admin bypass until collaborators exist; then turn off bypassing and update this.

## Structure
- One repository, one deployable (app/). Each service is a folder in
  services/ with its own contract/, src/, migrations/ and README.md.
- shared/kernel holds the seven shared identifiers: tenant ID, program ID,
  cycle ID, as-of date, entity ID, account ID, lineage reference.
  Nothing else is shared.

## Boundary rules (the build fails if they are broken)
1. Own your schema: only the owning service touches its tables and
   holds its migrations.
2. Ask, never join: reach another service only through its contract.
3. Import another service's contract package, never its internals.
4. No foreign keys across schemas: hold other services' data by identifier.
5. Announce changes through the outbox; every receiver is safe to repeat.
6. Every call, row and event carries the tenant ID; program-scoped data
   also carries the program ID.
7. No transaction spans two services: use two steps and an event.

## Behaviour
- Do what was asked and nothing more. Note other problems; do not fix them.
- If a choice is not settled in docs/design or docs/decisions, stop and
  write a DECISION REQUIRED block: the options, your recommendation, and
  what each costs. Do not guess.
- Money and rates use decimal arithmetic, never floating point.
- Schema changes are migrations in the owning service, never a sync from code.
- An approved cycle is never changed. A correction starts a new cycle.
- Never say a check passed unless you ran it. Say which checks you ran.

## Commands
- npm run check: the build checks for rules 1 to 6. Rule 7 is checked in review.
- npm test: check, kernel and service tests. npm run typecheck: tsc.
- Database tests need TEST_DATABASE_URL (a database named *_test; see
  docker-compose.yml). Without it they are skipped and say so: not a pass.
- npm run db:migrate applies every service's migrations (DATABASE_URL).

## Finishing
Report in a few lines: what changed, which checks ran and their result,
and what is left.
