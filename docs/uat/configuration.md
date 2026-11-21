# UAT configuration (E2)

`packs/uat/config.json` holds the fictional tenant name, OIDC issuer and subjects, six actors (five tenant users and one platform user), two programs, mapping rules, hedge policies, rate settings and simulator portfolios. The script contains no tenant-specific choices. `externalSubject` is a plain config value so the later sign-in work can change the claim in one place.

On an empty `_uat` or `_test` database, apply the migrations, then configure:

```powershell
$env:DATABASE_URL = "postgres://.../fx_uat"
npm run db:migrate
npm run uat:configure -- --config packs/uat/config.json
```

The script creates the tenant, ensures the platform user, enables the two programs, adds tenant users and their roles, defines program settings, drains the program announcements, adds mapping rules, saves policies, sets rate preferences and drains again. Segregation of duties remains on. A second run with the same tenant name refuses before making changes. A database unique index guards concurrent creation. The program definitions and mapping rules require the two-program shared-GL change from PR #24.

Master data is loaded later through D's file loader, after the configuration. This script never writes a service table directly.

`npm run uat:reset` drops all service schemas in the selected database, including the migration records. It refuses every database whose name does not end in `_uat` or `_test`; then `npm run db:migrate` recreates the schemas. Reset is for a disposable UAT database only.
