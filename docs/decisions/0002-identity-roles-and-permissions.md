# 0002 Identity: roles and permissions

Date: 2026-11-18. Service: identity. Builds on 0001.

The roles and permission names are carried over from the current system and regrouped by the new services.

## Decided
1. **Data permissions are collapsed.** The current import, validate, map and publish permissions per data type (GL balances, forecasts, orders, AR/AP, market data) become one set: `data-source:import`, `validate`, `map`, `publish`.
2. **No separate lock permission.** Approval already freezes a cycle, so `snapshot:lock` is dropped. The snapshot permissions become cycle permissions.
3. **TENANT_ADMIN is removed.** Operational set-up (creating a tenant, assigning programs, adding the first users) is done by the platform role SYSTEM_ADMIN. Inside a tenant, TREASURY_ADMIN manages users and roles.

## Roles
Tenant roles: VIEWER, TREASURY_ANALYST, TREASURY_REVIEWER, TREASURY_APPROVER, TREASURY_ADMIN. Platform role: SYSTEM_ADMIN, outside any tenant.

| Role | Permissions |
|---|---|
| VIEWER | every `:read` |
| TREASURY_ANALYST | reads, `data-source:import/validate/map/publish`, `cycle:initiate`, `hedge-recommendation:generate` |
| TREASURY_REVIEWER | reads, `cycle:initiate`, `hedge-recommendation:generate/review/dismiss` |
| TREASURY_APPROVER | reviewer's, plus `cycle:approve`, `cycle:skip`, `hedge-recommendation:accept` |
| TREASURY_ADMIN | every permission |
| SYSTEM_ADMIN | every permission in any tenant; each use is reported so it can be written to Audit |

`cycle:initiate` covers starting a cycle and rerunning it before approval. `cycle:skip` covers skipping or deleting a cycle that is holding the next one. The approver holding `cycle:skip` is new, not carried over, and was confirmed.

## Revisit when
Business support staff need to do tenant set-up without the IT-level platform role. Then add a second platform role.
