# 0004 Master Data: model, history and how changes arrive

Date: 2026-11-18. Service: master-data (supporting tier).

TMS accounts are removed from the design. Nothing in the core flow asks for them, and the current system has no equivalent.

## Decided
1. **The model is the current one.** Entities form a tree (type, country, parent, functional currency on legal entities, treasury and hedge-execution flags). Charts of accounts, the GL hierarchy and accounts carry the statement type, normal balance, and monetary and FX-relevant flags. Mapping accounts to programs stays in Data Source.
2. **History is versioned rows.** Every entity, hierarchy node and account version has a valid-from and a valid-to (end exclusive). The database refuses overlapping versions of the same item or the same code. A lookup "as of a date" reads the version valid on that date.
3. **One write path for every change.** ERP and TMS syncs, uploads and manual edits all arrive as a change set, one kind at a time (entities, hierarchy, accounts). Connectors and file parsing stay outside this service. A full snapshot is keyed by tenant, source system, kind and date, so repeating it changes nothing. Each applied change set announces one event with identifiers only.
4. **Safeguard.** If a snapshot would end more than a set share of the open rows of that source and kind, it is held for review and nothing is applied until someone releases or rejects it.

## Defaults I chose, to confirm or change
- The share is **20%**, set per tenant, and only applies when 10 or more rows are open.
- A change set dated earlier than the latest version of its kind is refused, so history is never rewritten.
- A snapshot sent twice with the same key and the same content is a repeat. Sent with different content, it is refused until the first is rejected or a new date is used.
- A snapshot only ends rows that came from the same source system. Manual rows are never ended by a sync.

## Not built yet
Ending a single row by hand outside a snapshot, and the screens.

## Revisit when
A service needs TMS accounts, or a source needs deltas instead of full snapshots.
