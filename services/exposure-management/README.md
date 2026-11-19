# Exposure Management

Tier: core.

## Owns
- Programs, their types and settings (netting level, display currency, date buckets, schedule), with the combination rules
- The cycle record: stages (initiated, in progress, completed), outcomes (skipped, deleted), reruns, approval, and the settings in force when it started
See docs/decisions/0007-exposure-management.md.

## Answers
- Program catalog
- A program's settings as of a date
- A cycle and its stage, and a program's cycles
- Which cycles the schedule says are due
Each is defined in contract/.

## Announces
- Cycle initiated (also on a rerun)
- Cycle completed
- Cycle approved
- Cycle skipped, cycle deleted
- Program changed
Events carry identifiers only.

## Consumes
- Run started and run finished, each with a run ID (Exposure Analysis)
- Program enabled and disabled (Identity)
- Access decisions (Identity's questions), before every command

## Schema
`exposure_management`. Its tables are defined by this service's migrations.
