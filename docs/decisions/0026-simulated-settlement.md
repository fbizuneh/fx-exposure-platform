# 0026 — Rate-derived settlement in the UAT simulator

Fikre chose rate-derived settlement amounts for simulated executions on 2026-11-20. This elaborates the stream E choice recorded in the E1 design proposal (decision 0025).

Recommendation pre-trades may leave `settlement_amount` blank, while FX Trade's executed importer requires a positive amount. The simulator reads the generated rate file for the trade date. A spot or swap near leg uses spot; a forward, NDF or swap far leg uses a forward with the leg's exact value date. The amount is converted from deal to settlement currency using `decimal.js` and rounded to four places, matching FX Trade's amount precision. A direct or inverse rate is used when present; otherwise a cross is derived through USD, the UAT pivot. A missing required rate refuses the simulation.

Cost: E5 needs the generated rates alongside the pre-trade file (`--rates`), and the generator must produce the needed value dates. No service calculation rule changes. The simulator remains a separate file tool and does not write to a service.
