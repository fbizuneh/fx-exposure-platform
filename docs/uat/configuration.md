# UAT configuration (E2)

`packs/uat/config.json` holds two fictional tenant names, the OIDC issuer and subjects, five users created in each tenant, one platform user, one program per tenant, mapping rules, hedge policies, rate settings and simulator portfolios. The same generated financial and master-data files will later be loaded into both tenants. The script contains no tenant-specific choices. `externalSubject` is a plain config value so the later sign-in work can change the claim in one place.

On an empty `_uat` or `_test` database, apply the migrations, then configure:

```powershell
$env:DATABASE_URL = "postgres://.../fx_uat"
npm run db:migrate
npm run uat:configure -- --config packs/uat/config.json
```

The script checks both names before writing, creates both tenants, ensures the platform user, then for each tenant enables its program, adds users and roles, defines settings, drains the program announcements, adds mapping rules, saves a policy and sets rate preferences. Segregation of duties remains on. A second run refuses before making changes. A database unique index guards concurrent creation.

Master data is loaded later through D's file loader, after the configuration. This script never writes a service table directly.

`npm run uat:reset` drops all service schemas in the selected database, including the migration records. It refuses every database whose name does not end in `_uat` or `_test`; then `npm run db:migrate` recreates the schemas. Reset is for a disposable UAT database only.
