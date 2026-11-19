# FX Exposure Platform — The Evolution Path

Nov 18, 2026 · @Fikre

## Purpose

We start as one deployable, and any service can later become its own deployable without a rewrite. This document names the few rules that make that true, the steps to extract a service, and the checks that stop the rules decaying.

It takes the earlier documents as given: seven services and two generic ones, one schema per service, questions answered by the owner and never joined across schemas, events carrying identifiers, owned copies, and results saved under the cycle ID. It does not choose a queue, a hosting platform or a date for any extraction.

## Where we start and where we can go

We start with every service as a module in one deployable, each with its own schema. Any one of them can later run alone, and Data Source is drawn here only as an example.

&#91;embedded content: one deployable now, Data Source on its own later\]

## The rules that keep extraction cheap

Seven rules, followed from the first line of code. Each one removes something that would otherwise have to be untangled on the day a service leaves.

| Rule | In practice | Why it matters on extraction day |
| --- | --- | --- |
| 1. Own your schema | Only the owning service's code reads or writes its tables, and it holds its own migrations. | The schema moves to its own database as it is. |
| 2. Ask, never join | Another service is reached through its interface, never through its tables, entities or repositories. | A call that was in-process becomes a network call with nothing else changed. |
| 3. Share contracts only | Each service publishes its question and event shapes in one contract package. The other services import that package and nothing else of it. | The contract is already the API. |
| 4. No keys across schemas | A reference to another service's data is one of the seven shared identifiers, held by value. The owner validates it when asked; the database does not. | No constraint breaks when the schemas separate. |
| 5. Events through an outbox | A change and its announcement are written in one transaction, and every receiver is safe to repeat. | Moving to a queue changes the transport, not the consumers. |
| 6. Tenant and program IDs | Every call, row and event carries the tenant ID. Anything that belongs to a program also carries the program ID, and queries for it filter on both. | Isolation does not depend on sharing a process or a database. |
| 7. No transaction across services | A step that changes two services is two steps with an event between them. | Nothing relies on a commit that spans services. |

## How a service is extracted

Extraction is five steps, and the first two can be undone by switching the caller back.

1. **Confirm the rules hold.** The automated checks pass for that service with no exceptions.
2. **Run it as its own process.** It still uses the same database server, and the other services call it over the network through the same contract. Their code does not change; only the client behind the contract does.
3. **Move its schema to its own database.** Rules 1 and 4 mean nothing else touches those tables and no key spans schemas, so the data moves as it is.
4. **Move its events to a queue.** The outbox feeds the queue, and every receiver is safe to repeat, so consumers are untouched.
5. **Deploy and scale it alone.** The in-process module is removed.

What does not change: the contracts, the tenant ID on every call, the saved records under each cycle ID, and the code of every other service.

## Which services might leave first

Nothing here is scheduled. Extraction costs effort, so a service leaves only when a concrete signal says the cost is worth paying. This is my expectation of the order, from the supporting and generic tiers outward.

| Service | Likely reason to leave | Signal that it is time |
| --- | --- | --- |
| Identity, tenancy and access; Audit | Generic: a bought or shared service can do the job | A product or vendor decision to replace them, behind the same contract |
| FX Rate | Every service depends on it, and its providers have their own availability | Rate sourcing needs its own uptime or is wanted by another product |
| Data Source | Heavy file and feed intake, and credentials to source systems | Intake load slows interactive use, or a customer needs connectors inside its own network |
| Exposure Analysis | Compute concentrated at cycle time | Runs need more capacity than the shared deployable gives |
| Master Data, FX Trade | Supporting, with modest load | No expected reason; they stay in the deployable |
| Exposure Management, Hedge Recommendation | Core: the logic that differentiates the product | They leave last, if a team boundary ever calls for it |

## How we keep the rules true

Rules that rely on memory decay, so six of the seven are checked by the build and a failure blocks the merge.

| Check | Fails when | Rules |
| --- | --- | --- |
| Import boundary | A service imports anything of another service except its contract package | 2, 3 |
| Schema access | Code reads or writes a table outside its own schema, or a migration adds a key to another schema | 1, 4 |
| Contract test | A published question or event changes shape without the consumers' tests passing | 3 |
| Replay test | Delivering the same event or batch twice changes state the second time | 5 |
| Tenant and program test | A query or event without a tenant ID succeeds, or a call returns another tenant's or another program's data | 6 |

Rule 7, no transaction across services, cannot be checked by a tool. It is a standing item in code review.

## Decisions

All four decisions are settled, each as recommended. Later documents build on them.

1. **How is a question asked inside the deployable?** Decided: each service exposes its questions as a typed interface in its contract package. Inside the deployable the call is a direct function call through that interface, and extraction swaps in a network client behind it.
2. **How do contracts change?** Decided: additive changes within a version. A breaking change gets a new version that runs beside the old one until every consumer has moved.
3. **One repository or several?** Decided: one repository and one deployable at first, with each service in its own top-level folder and contract package. Splitting the repository comes after, if ever, a service is extracted.
4. **Is an extraction recorded?** Decided: each one gets a short decision record naming the signal that justified it, so the cost is always tied to a reason.
