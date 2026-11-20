# 0015 Pair-to-exposure-currency mapping per hedging program

Status: accepted. Follows decision 0008 (override in program settings) and 0010 (hedge rows follow the same rule).

## Decisions (from the owner)
1. The mapping lives in **Master Data**, kept **per hedging program**: two programs can map the same currency pair differently.
2. The **program's own override** in its Exposure Management settings **wins** over the Master Data mapping.
3. The mapping is read **as of the cycle's as-of date** and the run saves the mappings it used.
4. **Both mechanisms stay**: Master Data is the reference mapping beneath; the program-settings override sits on top. The overlap is deliberate.

## What it does
- New Master Data table `pair_exposure_currencies` (program-scoped, versioned, tenant isolated): program, pair, exposure currency. The pair is stored in alphabetical order, so `GBP-EUR` and `EUR-GBP` are one mapping. The exposure currency must be one of the pair.
- Loaded like other reference data: a change set of kind `EXPOSURE_CURRENCY`, snapshot or partial, versioned from its date, audited, one `master-data.changed` event per applied set.
- Question `getPairExposureCurrencies(tenant, program, asOf)`. Another program's mappings are never returned.
- Exposure Analysis merges them into the existing override map (Master Data first, program overrides set after). The mapping therefore applies exactly where the override does: levels without an entity, and hedge rows at entity levels where neither leg is the entity's functional currency. Gross, hedge and net rows stay aligned.
- Fixed rules stay fixed: portfolio level uses the non-portfolio currency; an entity level with a functional leg uses the other leg.
- A pair with no mapping behaves as before (default ranking; deal currency for hedges).
- The run stores the mappings it used in `runs.pair_mappings`.

## Not built
Mapping by entity or region; a platform-wide default mapping across programs; a screen or file format for maintaining mappings beyond the change-set command.
