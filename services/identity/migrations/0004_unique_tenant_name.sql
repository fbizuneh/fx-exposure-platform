-- Tenant names identify a UAT configuration. Refuse duplicates atomically, including disabled tenants.
CREATE UNIQUE INDEX tenants_name_unique ON identity.tenants (name);
