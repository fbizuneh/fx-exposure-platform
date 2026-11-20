# 0012 Audit: the change trail

Date: 2026-11-20. Service: audit (generic tier). Sources: the Data Ownership table (Audit answers "the audit trail" and consumes change records from every service), decisions 0001 and 0002 (every use of the platform role is written to Audit), AGENTS.md (events carry identifiers only), the product owner's answers of 2026-11-19.

## Decided
1. **Change records through the contract.** A service that makes a governed change announces a change record in the same transaction as the change (rule 5), as `<service>.change-recorded`. The shape is `ChangeRecordFields` in Audit's contract: tenant, program (or none), actor, action, target type, target ID, field names. Services import that shape from Audit's contract; Audit imports nothing from them. The dispatcher in `app/` delivers every event whose type ends in `.change-recorded` to Audit.
2. **A record holds identifiers, an action and the names of the fields that changed.** No values: the owning service keeps them, and Audit does not become a second store of financial or personal data. Where the thing that changed is itself an identifier it goes in the target (a role grant is target `<user>/<ROLE>`), not in a field.
3. **Append-only, tamper-evident.** The table refuses UPDATE, DELETE and TRUNCATE with a trigger. Each tenant has one hash chain: a record's hash covers its content and the hash before it. `verify` recomputes the chain and reports the first position that does not match, including a record cut off the end. Appending takes a per-tenant lock, so records join one at a time.
4. **Positions follow arrival at Audit.** `seq` is the order Audit received records, not the order the changes happened; `occurredAt` is when the change happened. Records from one service arrive in order; across services a delayed delivery can sort later than a change that happened after it.
5. **Safe to repeat.** The announcement's event ID is the record ID; delivering it again changes nothing.
6. **Reading needs `audit:read`.** Held by TREASURY_APPROVER and TREASURY_ADMIN (and the platform role). It was in every `:read` permission, so viewers had it; it is now left out of the role's general reads. Reading is tenant-scoped; asking for one program needs the permission in that program.
7. **What is recorded (first version): governance and money-affecting actions.**
   - Identity: user added, role granted or revoked, program restriction set, user disabled, program enabled or disabled, and every use of the platform role (action `platform-role.used`, target the permission). A repeat that changes nothing records nothing.
   - Exposure Management: program defined, settings changed; cycle started, rerun, skipped, deleted; exposure approved; cycle approved.
   - Hedge Recommendation: policy set (changed field names; `policy` for the first one); recommendation accepted, overridden or dismissed. The record is written with the winning claim, so a decision that lost a race, a refused one, or a retry that finishes the claimed decision adds nothing.
   - FX Trade: manual pre-trade created, released, cancelled; pre-trade sent (one per pre-trade in an export); executed trade matched by a user or cancelled.
   - Master Data and FX Rate: change sets and rate loads made by a person (actor `user:` or `platform:`). Feeds from source systems are routine loads and are not recorded.
   Not recorded: Data Source loads, Exposure Analysis runs, and anything automated. Pre-trades made from an accepted recommendation are covered by the acceptance.

## Defaults I chose (change them if you disagree)
- Actor labels are the service's own: `user:<id>` or `platform:<id>`. Identity commands take a bare ID as `by`, so its records carry the bare ID; the label is not made uniform here.
- `setProgramRestriction` now takes who made the change, since the record needs it.
- Platform-role use is recorded when the access question is answered, so it also covers reads such as reading the trail. Tenant admins can read those records too; hiding them from tenants would need a second, platform-only view.
- The cycle approval's release of drafts (a system act) is covered by `cycle.approved`.

## Known gaps (recorded, not built)
Retention and purge (needs a retention rule from you); a read restricted to the programs a user holds (a program-restricted user with `audit:read` and no program named sees the whole tenant trail); export of the trail; Data Source and Exposure Analysis records; a platform-only view of platform-role use; one actor label format across services.
