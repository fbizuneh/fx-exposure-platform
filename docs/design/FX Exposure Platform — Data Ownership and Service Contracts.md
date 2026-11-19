# FX Exposure Platform — Data Ownership and Service Contracts

Nov 18, 2026 · @Fikre

## Purpose

This document defines what each service owns and how services talk to each other, so that no service ever needs another's tables. It treats the decisions in the glossary and context map as settled: Data Source owns the program mapping rules and stamps the program ID, Exposure Management owns programs and the three-stage cycle, FX Trade supports with execution outside the application, and each service has its own database schema.

It settles the shared kernel, each service's interface, the program ID flow and the sync model. It does not settle field-level schemas, endpoint shapes or technology.

## Shared kernel

Seven identifiers cross every boundary; everything else stays inside its owner. Each is defined by exactly one service, and the others only carry it.

| Identifier | Defined by | How others use it |
| --- | --- | --- |
| Tenant ID | Identity, tenancy and access | Scopes every call, every row and every schema query |
| Program ID | Exposure Management defines programs; Data Source stamps balances with it | Carried on exposure rows, trades and recommendations from the moment it is stamped |
| Cycle ID | Exposure Management | Ties a run, its exposures and its recommendations to one initiated, in progress or completed cycle |
| As-of date | Data Source, from the source system | Drives rate selection and bucket assignment; never the processing date |
| Entity ID | Master Data | Held by reference; never copied with its attributes |
| Account ID | Master Data | Held by reference next to the source account code as received |
| Lineage reference | Data Source (source system, batch, record) | Passed through to exposure rows so any number can be traced back to a source record |

Currency codes follow the ISO standard and need no owner.

## Service contracts

Each service is reached in two ways: a question it answers on request, and an event it announces when something changes. Events carry identifiers and let the receiver ask for detail.

| Service | Answers on request | Announces | Consumes |
| --- | --- | --- | --- |
| Exposure Management | Program catalog; a program's settings; a cycle and its stage | Cycle initiated; cycle completed; program or settings changed | Run finished (from Exposure Analysis); programs enabled (from Identity) |
| Exposure Analysis | Exposure by program, cycle, date bucket and currency pair, with lineage; the evidence of a run | Run finished | Included balances (Data Source); pre-trades and executed trades (FX Trade); rates (FX Rate); functional currencies (Master Data); settings (Exposure Management) |
| Hedge Recommendation | Recommendations for a cycle and their follow-up status; its hedge policy | Recommendation issued; pre-trade created | Exposure (Exposure Analysis); executed trades (FX Trade); settings (Exposure Management) |
| Data Source | Included balances for a program, as-of date and scope; ingestion status; data quality issues | Batch stamped; issues raised (a blocked balance is an issue) | Files and feeds from source systems; entities, accounts and hierarchy (Master Data); program catalog (Exposure Management) |
| Master Data | Entities, accounts and hierarchy walks as of a date | Master data changed | ERP and TMS syncs or manual uploads |
| FX Rate | The rate for a pair, date and tenor | Rates loaded for a date | Rate providers |
| FX Trade | Pre-trades and executed trades by program, entity and period | Pre-trade ready to send; executed trade received | Pre-trades (Hedge Recommendation or manual entry); executed trade files from outside; entity mapping (Master Data) |
| Identity, tenancy and access | Who may do what in which tenant and program; which programs a tenant has enabled | Program enabled or disabled | Nothing |
| Audit | The audit trail | Nothing | Change records from every service |

Two boundaries are one-way by design. Data Source never asks Exposure Analysis anything, and Master Data never asks any service anything except its outside systems.

## The program ID seam

A balance is stamped once, inside Data Source, and Exposure Analysis only ever receives the included ones.

&#91;embedded content: program ID flow · 7 steps across 5 services\]

Blocked balances stay in Data Source as data quality issues and never reach a run. Excluded balances are recorded but out of scope. Step 6 also draws rates from FX Rate and hedges from FX Trade, which are left off for clarity.

## Consistency and sync

Five rules keep the services consistent without sharing a database.

1. **Owned copies.** Each service stores what it needs from outside systems and from other services' announcements, so a calculation never waits on an ERP, a TMS or another service being available.
2. **The as-of date is data.** A file for last week can be processed today and is stamped with its own as-of date. A missed day keeps its cycle open until a user skips or deletes it, and the next cycle for that tenant and program waits for that.
3. **Safe to repeat.** Every inbound batch and every event has a key, so receiving it twice changes nothing. A failed step can be retried or replayed.
4. **Effective-dated lookups.** Master data is read as of a date, so history does not change when an entity or account changes later.
5. **Saved, not recalculated.** Each run saves its exposures, rates, hedges, decisions and pre-trades under its cycle ID. Once the cycle is approved, the record is kept unchanged for future reference, and the application retrieves it instead of recalculating.

In the first release, events run inside the one deployable and are also written to an outbox table. Moving them to a queue later then changes the transport, not the consumers.

## Decisions

All seven decisions are settled, each as recommended. Later documents build on them.

1. **What is a program ID?** In the earlier design a tenant had at most one program of each type, so the program code identified it. Decided: keep the program code. It is simple, and a tenant that switches from Daily to Monthly keeps history under the old code.
2. **Do events carry data or only identifiers?** Decided: identifiers only. The receiver asks the owner for detail, so the owner stays the single source of truth.
3. **Who enforces the program combination rules when a program is enabled?** Decided: Exposure Management validates the combination and Identity records the result, so the rules live with programs and the access record stays simple.
4. **How does Data Source know which programs exist?** It needs program IDs and types to stamp balances. Decided: Exposure Management announces program changes and Data Source keeps a small reference copy.
5. **What happens when a late or corrected file arrives for a completed cycle?** Decided: the data is stored and stamped, but an approved cycle is never changed; a correction starts a new cycle by an explicit user action in Exposure Management, never silently.
6. **What is the unit of a data feed?** Decided: one batch per tenant, source system, data type and as-of date, so a replay or a correction targets exactly one batch.
7. **Where does approval sit, and who holds the saved record?** Approval is a step beyond initiated, in progress and completed. Decided: completed means the run finished, and Exposure Management records the approval. Each service then freezes its own part under the cycle ID: exposures and the rates used in Exposure Analysis, decisions in Hedge Recommendation, pre-trades and executed trades in FX Trade. Exposure Management holds the cycle record that points to them.
