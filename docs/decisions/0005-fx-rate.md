# 0005 FX Rate: a small core

Date: 2026-11-18. Service: fx-rate (supporting tier).

## Decided
1. **Small core.** FX Rate stores rates, accepts them as loads (file or manual entry, parsed outside), validates them, records each load, and derives inverse, cross and identity rates on request. Feeds, publication generations, reconciliation and snapshots from the old system are left out: the Core Flow already saves the rates each run used under its cycle ID.
2. **Rate types: spot and forward only.** The others (fixing, month-end, budget, forecast, accounting) wait until a service needs one.
3. **Per tenant, per source.** Every rate belongs to a tenant and a source (a provider, a bank, "manual"). A tenant may name a preferred source.
4. **Which rate a lookup returns.** For a pair, as-of date and tenor, the latest load of a valid rate from the preferred source (or from any source if none is preferred). If only a stale or outlier rate exists, it is returned with that quality shown, never as valid.

## Defaults I chose, to confirm or change
- Rates are exact decimals, 10 places. Inverse and cross rates are rounded to 10 places.
- A source is stale after a per-source number of minutes. Age is measured from the observation to the end of its business date, not to the day it is loaded, because a file for an earlier date may be processed later. No limit if not set.
- An outlier warning is raised when a rate differs by more than 10% from the prior valid rate for the same source, pair and tenor. The share is a per-tenant setting.
- A rate dated in the future, or observed in the future, is refused.
- A forward needs a tenor code (1W, 1M, 3M ...). A value date is optional. A forward given only a value date is refused for now.
- A load with any invalid row is refused whole, like a Master Data change set. An empty load is refused.
- Lookups use the as-of date exactly. If a date has no rate, the answer is none; there is no fallback to an earlier day.
- Cross rates go through a pivot currency, USD unless the tenant sets another.
- A load sent twice with the same source, date and content is a repeat and changes nothing.

## Not built yet
Provider connectors, the screens, rate approval, and the other rate types.

## Revisit when
A real provider feed needs publication generations, or a program needs a fallback to the previous day.
