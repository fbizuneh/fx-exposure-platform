# 0003 Identity: users belong to a tenant

Date: 2026-11-18. Service: identity. Changes part of 0001.

0001 had one global user table and a membership linking a person to each tenant. That left one table without a tenant ID.

Options: A, keep global users with memberships; B, each user belongs to one tenant, and platform staff are kept apart.

**Decided: B.**
- Every user row carries the tenant ID and is unique per tenant and sign-in identity.
- Roles and the optional program restriction attach to the user. The membership table is dropped.
- System Admin staff are platform users, in their own table outside any tenant. It is the only identity table without a tenant ID.
- A consultant who needs several tenants gets a separate user in each one.

## Revisit when
Real people need one sign-in across tenants. Then add a link between users in different tenants, or return to A.
