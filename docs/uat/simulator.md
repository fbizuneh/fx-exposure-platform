# Demo execution simulator (E5)

The simulator writes a fictional executed-trade CSV from a released pre-trade CSV. The counterparty names and platform ID are fictional. It makes no database writes.

```sh
npm run uat:simulate -- --pretrades path/to/pretrades.csv --rates path/to/rates-for-trade-date.csv --trade-date 2026-11-20 --seed 42 --out path/to/executed.csv
```

The extra `--rates` input is required because the executed file needs a positive `settlement_amount` and recommendation pre-trades may leave it blank. It reads `packs/uat/config.json` for `simulator.portfolioByProgram`; `--config path/to/config.json` overrides that path. For each trade leg, it uses the generated spot rate for a spot or near leg, or the forward rate with that leg's exact value date. It handles inverse pairs and crosses through USD. A missing rate refuses simulation. Decimal amounts are rounded to four places for the FX Trade importer.

`--partial S` executes a share `S` of the remaining pre-trades, and `--reject S` rejects a share before partial selection. Each share is from 0 to 1. Selection is seeded and whole-pre-trade, so both swap legs are always included or excluded together. The same inputs and seed give byte-identical output. The output echoes each pre-trade reference and program ID so FX Trade can match it.

The rate file uses the FX Rate layout's `base`, `quote`, `type`, `value_date` and `all_in` columns. E3 will generate these files after D1 is merged. The simulator's database test uses the real approval, release and import path; it is skipped when `TEST_DATABASE_URL` is unset.
