# 0027 — Unique tenant names for UAT configuration

Fikre chose Identity uniqueness and lookup for tenant names on 2026-11-20 (stream E, E2). A name identifies at most one tenant, including disabled tenants. The equality rule is exact text equality, matching the existing `name` field; case and whitespace normalization are not introduced here.

Identity owns the unique database index and answers `tenantByName(name)` with the tenant ID or null. E2 checks this question before configuration, while the database index is the final race guard when two callers create the same name concurrently.

`createTenant` translates the index's duplicate-name violation to the contract error `TenantNameTaken`. The migration first lists duplicate existing names in its failure message, so an operator can resolve them before restarting the runtime.

Cost: Identity's migration and contract change; any existing duplicate names must be resolved before the migration can apply. Tests that create many independent tenants must use distinct names. No tenant is renamed or deleted automatically.
