# 0024 — UAT pack choices

Fikre confirmed these choices for Release 1 stream E on 2026-11-20. They settle the direction; each affected service change still needs its own review and tests.

1. **Two balance sheet programs on the same GL.** `BS-ENT` and `BS-REG` consume the same GL balances under different mapping rules. This supersedes the one-balance-sheet-program combination rule and Data Source's one-program-per-balance stamp for this use. Cost: Exposure Management and Data Source contracts, persistence and tests must support two program memberships without cross-program leakage.
2. **Unique tenant names.** Identity enforces a unique name and exposes a name lookup so UAT configuration refuses an existing tenant before writing. Cost: an Identity migration, contract change and concurrency test. The unique constraint remains the final race guard.
3. **Simulated settlement amounts use generated rates.** The demo execution simulator computes the positive settlement amount from the generated rate for the trade and value date when the pre-trade leaves it blank. It refuses a missing rate. Cost: simulation depends on the generated rates and their file layout.

The 12 UAT scenarios supplied by Fikre are copied verbatim into `docs/uat/data-design.md`.
