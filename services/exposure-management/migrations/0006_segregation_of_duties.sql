-- Tenant-level settings of Exposure Management. Segregation of duties is on unless a tenant admin switches it off (decision 0013).
CREATE TABLE exposure_management.tenant_settings (
  tenant_id              uuid PRIMARY KEY,
  segregation_of_duties  boolean NOT NULL DEFAULT true,
  updated_by             text NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
