# Audit

Tier: generic.

## Owns
- The audit trail: one append-only, hash-chained list of change records per tenant (decision 0012)
- Who changed what and when, as identifiers, an action and the names of the fields that changed (no values)

## Answers
- A tenant's trail, filtered by program, actor, action, target or time, and paged (needs audit:read; a reader limited to some programs sees only those programs' records)
- Whether a tenant's chain is intact (needs audit:read and no program limit)
Each is defined in contract/.

## Announces
- Nothing
Events carry identifiers only.

## Consumes
- Change records from every service, announced as `<service>.change-recorded` in the same transaction as the change; delivered by the dispatcher in app/
- Which services record what is listed in decision 0012. Routine loads and automated steps are not recorded.

## Schema
`audit`. Its tables are defined by this service's migrations. The records table refuses update, delete and truncate.

## Notes
- Positions follow arrival at Audit, not the time of the change; `occurredAt` is the time of the change.
- Receiving the same record twice changes nothing.
