# Identity, tenancy and access

Tier: generic.

## Owns
- Tenants, users and memberships
- Invitations
- Fixed roles, with permissions as named checks
- A membership's optional program restriction (none means all programs)
- Who may do what in which tenant and program
- Which programs a tenant has enabled
See docs/decisions/0001-identity-model.md and 0002-identity-roles-and-permissions.md.

## Answers
- Who may do what in which tenant and program
- Which programs a tenant has enabled
Each is defined in contract/.

## Announces
- Program enabled or disabled
Events carry identifiers only.

## Consumes
- Nothing

## Schema
`identity`. Its tables are defined by this service's migrations.
