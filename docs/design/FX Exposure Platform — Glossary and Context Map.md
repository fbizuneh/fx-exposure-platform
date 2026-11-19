# FX Exposure Platform — Glossary and Context Map

Nov 18, 2026 · @Fikre

## Purpose

This document fixes the domain language and the service boundaries for a fresh start, before any code or data model. Everything here is a proposal until you confirm it, section by section.

It settles three things: what each term means, which services exist and in which tier, and who owns which data. It does not settle APIs, the data model, technology or deployment. Those follow in later documents, once these boundaries hold.

What to reuse from the current repository is decided afterwards, asset by asset, against this map.

## Glossary

Financial data and master data are different things, and most boundary decisions follow from keeping them apart.

| Term | Meaning | Note |
| --- | --- | --- |
| Financial data | Balances and transactions that change with each business day: GL balances, forecasts, cash balances, orders, AR/AP, intercompany loans | Arrives from a source system as of a date. This is what the data source service provides. |
| Master data | Slow-changing structure that financial data refers to: organization and legal entities, ERP chart of accounts and hierarchy, TMS accounts | Owned by a separate master data service. Not exposure input by itself. |
| Source system | The ERP, TMS or file that financial data or master data comes from | Cash balances may come from the ERP first and later from a TMS that overrides the ERP balance. |
| As-of date | The date the balances were taken in the source system | Drives FX rate selection. No processing cutoff: a file for last week can be processed today. A missed day is skipped. |
| Hedging program | A hedging strategy with its own scope, policy and netting level: Balance Sheet (daily, monthly, rolling), Cash Flow, Budget to Cash, In-House Bank | A tenant may run only one balance sheet program. Classic programs and Budget to Cash are mutually exclusive. |
| Program boundary | The line that says which financial data belongs to which program | Each balance carries exactly one program ID. An unmatched balance is blocked. An excluded balance is out of scope, not an error. |
| Mapping rule | A rule that assigns data to a program by single account or by account hierarchy node, or entity, or any combination of data dimensions with exclude rules for exceptions | Can also include or exclude by source system, entity and account. |
| Exposure | An amount in a currency pair, in a date bucket, that moves with FX rates, with its program and lineage | Calculated by the exposure analysis service. |
| Netting level | The level at which exposures offset each other: entity and pair, corporate and pair, region and pair | Configurable per program. |
| Exposure engine | The calculation: raw data, filter, normalize, baseline exposure, netting level, gross exposure, net exposure | Hedges run the same sequence. Built on currency pairs. |
| FX pre-trade | A soon to be executed forward, spot, NDF, or swap carrying its program ID and trading entity | Generated from the hedge recommendation process. Could also be created manually as a trade request. |
| FX trade | An executed forward, spot, NDF or swap, carrying its program ID and trading entity | Imported from a standard flat file. The source of truth is generally a TMS (treasury management system) or an execution platform like a trading platform. Execution platform examples: FXall, 360T. |
| Hedge recommendation | A proposed hedge action, from exposure compared with program policy | Policy decisions are configurable: percentage, amount, or VaR threshold. VaR comes later. |
| Post-execution action | What happens after a trade is executed | Owned with recommendations. Detail is open. |
| Tenant | A client organization. All data is isolated by tenant and by program |  |

## Context map

Three core services decide the programs, the exposure and the hedge; four supporting services hold the data they ask for; two generic services serve all of them.

&#91;embedded content: context map · 3 core, 4 supporting, 2 generic services\]

The core services run in sequence: Exposure Management defines programs and runs the cycle, Exposure Analysis calculates, Hedge Recommendation acts. Tier placement is my proposal; FX Trade's tier is settled in open question 5.

## Seams and data ownership

Each service owns its data and answers questions about it through one interface. No service reads another service's tables.

| Service | Tier | Owns | Answers | Asks |
| --- | --- | --- | --- | --- |
| Exposure Management | Core | Programs, program settings, combination rules, the program cycle, its schedule and stage | A program's configuration and cycle schedule | Nothing |
| Exposure Analysis | Core | The exposure engine, calculation runs and their results | Exposure by program, date bucket and currency pair | Data Source, Exposure Management, FX Rate, FX Trade |
| Hedge Recommendation | Core | Hedge policy, recommendations, post-execution actions | Recommended hedges and their follow-up | Exposure Analysis, FX Trade |
| Data Source | Supporting | Financial data with as-of date and lineage, program mapping rules and program stamps, ingestion runs, data quality issues | The included financial data for a program and date | Master Data, source systems ERP and TMS, on a schedule |
| Master Data | Supporting | Organization and legal entities, chart of accounts and hierarchy, TMS accounts | Lookups and hierarchy walks | ERP and TMS, on a schedule |
| FX Rate | Supporting | Spot and forward rates, rate sources | The rate for a pair, date and tenor | Nothing |
| FX Trade | Supporting | Executed trades and trades to go for execution, trade file imports | Trades by program, entity and period | Master Data |
| Identity, tenancy and access | Generic | Tenants, users, roles, which programs a tenant has enabled | Who may do what in which tenant and program | Nothing |
| Audit | Generic | The audit trail | Who changed what, when | Nothing |

Five rules hold these boundaries:

1. **Ask, never join.** A service reads another's data by calling its interface, never by querying its tables or importing its internals.
2. **A tiny shared kernel.** Only tenant ID, program ID, currency code, as-of date and identifiers are shared across services.
3. **References, not copies.** Financial data refers to master data by key. The program boundary is where the two meet: Data Source applies the program mapping rules, walks Master Data's hierarchy, and stamps each balance with its program ID. Exposure Management defines programs but never reads balances.
4. **The program ID travels.** It is carried on every exposure row and every trade from the moment it is stamped.
5. **Owned copies of outside data.** Master data and financial data are synced into our services, so a calculation never waits on an ERP or TMS being up.

## Open questions

Six decisions shape the boundaries above. Each has my recommendation; please overrule any of them.

1. **Who stamps the program ID?** Decided: Data Source stamps it at intake, as you first described, using the mapping rules it owns. An unmatched balance is blocked there.
2. **Where do account classification and program rules live?** Decided: Data Source keeps the program mapping rules and applies them, so Exposure Analysis asks for a program's balances and gets only the included ones, without calling Exposure Management for rules. Master Data keeps accounts, hierarchy and descriptive classification, which the rules refer to.
3. **Where does normalization happen?** Decided: Data Source normalizes to one canonical financial record (sign, currency, as-of date), and Exposure Analysis does its own "normalize" step into signed currency-pair rows, as in your workbook.&#32;
   1. &#32;I agree with this recommendation
4. **Who runs the program cycle?** Decided: Exposure Management owns the schedule, the program configuration and the cycle, which has three stages: initiated, in progress and completed. Exposure Analysis owns the run and its evidence, so a run can be reproduced from stored inputs.
5. **Is FX Trade core or supporting?** Decided: supporting. We send pre-trades out for execution and receive the executed trade definitions back; execution itself happens outside our application.
6. **How is data separated inside the first release?** Decided: modules in one deployable, with one database schema per service, so ownership is enforced by the database and not only by convention.
