# Exposure Management

Tier: core.

## Owns
- Programs and their settings
- The cycle record and its stages (initiated, in progress, completed)
- The approval record, and the record that points to each service's frozen part

## Answers
- Program catalog
- A program's settings
- A cycle and its stage
Each is defined in contract/.

## Announces
- Cycle initiated
- Cycle completed
- Program or settings changed
Events carry identifiers only.

## Consumes
- Run finished (Exposure Analysis)
- Programs enabled (Identity)

## Schema
`exposure_management`. Its tables are defined by this service's migrations.
