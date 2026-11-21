# Identity, tenancy and access

Tier: generic.

## Owns
- Tenants, and their users (each user belongs to one tenant)
- Platform users (System Admin), outside any tenant
- Invitations
- Fixed roles, with permissions as named checks
- A user's optional program restriction (none means all programs)
- Who may do what in which tenant and program
- Which programs a tenant has enabled
See docs/decisions/0001, 0002 and 0003 (identity-model, roles-and-permissions, users-belong-to-a-tenant).

## Answers
- Who may do what in which tenant and program
- Which programs a tenant has enabled
- Which tenants are active (platform level, no tenant; only the runtime asks, decision 0023)
- The tenant ID for an exact name, including disabled tenants (decision 0027)
Each is defined in contract/.

## Announces
- Program enabled or disabled
Events carry identifiers only.

## Consumes
- Nothing

## Schema
`identity`. Its tables are defined by this service's migrations.
