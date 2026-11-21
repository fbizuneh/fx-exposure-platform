-- Tenant names identify a UAT configuration. Refuse duplicates atomically, including disabled tenants.
DO $$
DECLARE duplicate_names text;
BEGIN
  SELECT string_agg(format('%L (%s rows)', name, copies), ', ' ORDER BY name)
    INTO duplicate_names
    FROM (
      SELECT name, count(*) AS copies
        FROM identity.tenants
       GROUP BY name
      HAVING count(*) > 1
    ) duplicates;
  IF duplicate_names IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot reserve tenant names; duplicate names exist: %', duplicate_names;
  END IF;
END $$;
CREATE UNIQUE INDEX tenants_name_unique ON identity.tenants (name);
