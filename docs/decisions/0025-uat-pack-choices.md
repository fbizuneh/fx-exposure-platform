# 0025 — UAT pack choices

Fikre confirmed these choices for Release 1 stream E on 2026-11-20. Decision 0024 belongs to D's per-service CSV readers.

1. **Two tenants, one balance sheet program each.** Both tenants load the same generated master data, rates and GL files. Tenant 1 runs `BS-ENT`; tenant 2 runs `BS-REG`. Each tenant has its own mapping rules, hedge policy and users. The 50-entity, 40-currency, 20,000-row size target applies to each tenant. Cost: the loader and rehearsal apply each file twice and expected results carry tenant/program scope. The existing one-program rule remains.
2. **Unique tenant names.** Identity enforces a unique name and exposes a name lookup so UAT configuration refuses an existing tenant before writing. Cost: an Identity migration, contract change and concurrency test. The unique constraint remains the final race guard.
3. **Simulated settlement amounts use generated rates.** The demo execution simulator computes the positive settlement amount from the generated rate for the trade and value date when the pre-trade leaves it blank. It refuses a missing rate. Cost: simulation depends on generated rates and their file layout.
4. **Cover Close-out+New in the regional program.** `BS-REG` combines amount-threshold with Close-out+New rolling, while `BS-ENT` combines hedge-ratio-adjustment with Adjust+Swap. Fikre chose this on 2026-11-20 for scenario 5. Cost: both policies need roll dates and calendar checks in the rehearsal.

The 12 UAT scenarios supplied by Fikre are copied verbatim into `docs/uat/data-design.md`.
