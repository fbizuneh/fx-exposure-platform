# FX Exposure Platform — The Core Flow

Nov 18, 2026 · @Fikre

## Purpose

One program cycle runs from data in to an approved, saved record, and every step belongs to exactly one service. This document follows a cycle end to end and settles who starts each step, what each service saves, and what happens when a step cannot finish.

It takes the earlier documents as given: the seven services and their tiers, the program ID stamped by Data Source, the three cycle stages owned by Exposure Management, pre-trades executed outside the application, one schema per service, and results saved under the cycle ID and never recalculated. It does not settle calculation methods (netting, bucketing, hedge sizing), screens or endpoint shapes.

## The cycle at a glance

Steps 1 to 6 build the saved record; steps 7 to 10 take the trades out and back. Data Source, FX Rate and Master Data answer step 2 and have no step of their own.

&#91;embedded content: cycle flow · 10 steps across 5 services and one outside system\]

## Stage by stage

A cycle takes six steps before anything is sent out. Steps 1 to 4 can run unattended; steps 5 and 6 need a person.

| Step | Service | What happens | Cycle state |
| --- | --- | --- | --- |
| 1. Start | Exposure Management | A schedule or a user starts a cycle for a program and as-of date. The cycle gets its ID and the program settings in force. | Initiated |
| 2. Collect | Exposure Analysis | Asks Data Source for the program's included balances at the as-of date (whatever it has at that moment), FX Rate for the rates, Master Data for each entity's functional currency, and Exposure Management for the settings. | In progress |
| 3. Analyze | Exposure Analysis | Filters the balances (legal entities, accounts flagged both FX-relevant and monetary, functional-currency balances dropped), normalizes them into signed currency-pair rows at the as-of date, nets them at the program's netting level, assigns date buckets, saves the result under the cycle ID, and announces the run finished. | Completed |
| 4. Recommend | Hedge Recommendation | Reads the exposure, the executed trades already in place and the settings, issues recommendations, and saves them under the cycle ID. | Completed |
| 5. Decide | Hedge Recommendation | A user accepts, changes or rejects each recommendation. The decision is saved with who and when. Accepted ones become pre-trades in FX Trade. | Completed |
| 6. Approve | Exposure Management | A user approves the cycle. Exposure Management records the approval and each service freezes its part. | Completed, approved |

A cycle is initiated until Exposure Analysis starts, in progress while it runs, and completed when it announces the run finished. Approval is a fact recorded on a completed cycle, as decided in the data ownership document.

## Trades and post-execution

The application never executes a trade. It sends pre-trades out and takes executed trades back, and FX Trade is the only service that touches either.

1. **Release.** FX Trade releases the pre-trades of an approved cycle and announces them ready to send. A pre-trade can also be entered by hand.
2. **Execute outside.** Execution happens in a system or with a counterparty outside the application. Nothing in the cycle waits on it.
3. **Receive.** Executed trade definitions come back as files or entries. FX Trade matches each to its pre-trade, or stores it unmatched with the program, entity and period, and announces it received.
4. **Follow up.** Hedge Recommendation reads the executed trades and updates the follow-up status of each recommendation: executed, partly executed, or still open.
5. **Next cycle.** The next cycle's recommendations start from the executed trades now in place, so a hedge already done is not recommended again.

Executed trades arrive after approval, sometimes days later. They are attached to the approved cycle as new records and never change what was saved when it was approved.

**Demo simulator.** For an end-to-end demo, a simulator plays the outside trading platform. It sits outside the seven services, takes the released pre-trades the way a real platform would, and returns executed trade definitions in the same form. FX Trade cannot tell the difference, so no service contains simulated execution and the demo exercises the real path.

## What is saved under the cycle ID

Each service saves its own part in its own schema, and Exposure Management holds the cycle record that points to them. Retrieving an old cycle reads these parts and calculates nothing.

| Service | Saved under the cycle ID | Frozen |
| --- | --- | --- |
| Exposure Management | The cycle record: program, as-of date, settings in force, stage changes, who approved and when, pointers to the other parts | At approval |
| Exposure Analysis | Exposures by currency pair and date bucket with lineage; the rates and functional currencies used | At approval |
| Hedge Recommendation | Recommendations, decisions with who and when, follow-up status | Recommendations and decisions at approval; follow-up status keeps updating |
| FX Trade | Pre-trades; executed trades attached after approval | Pre-trades at approval; executed trades are added, never edited |
| Data Source | Nothing under the cycle ID. It keeps every batch that a saved exposure row points to, so lineage always resolves | Not applicable |
| FX Rate | Nothing. Exposure Analysis saves the rates it used, so a later rate change cannot alter an old cycle | Not applicable |

## When things go wrong

No step guesses. A step that cannot finish says why, and the cycle keeps what it has.

| Situation | What happens |
| --- | --- |
| No balances for the as-of date | The cycle stays initiated and open for a refresh, because an ERP feed may be late or a Data Source check may be holding the data. It is never completed with zero exposure, and while it is open no other cycle can start for that tenant and program until a user skips or deletes it.&#32; |
| Some balances are blocked | Data Source answers with the balances it has at the time of the request. Blocked ones stay there as data quality issues and are not returned. The run reports how many were left out. Question 2 asks whether it may complete. |
| A rate is missing for a pair and date | The run stops and names the pair and date. No rate is substituted silently. The cycle stays initiated and waits until the missing rates are resolved. |
| A service is unavailable | The step fails and the cycle stays in progress. The step is retried; because every step is safe to repeat, a retry changes nothing twice. |
| An executed trade matches no pre-trade | It may be a trade a user executed outside the hedging process. If its characteristics match and it belongs to the program, FX Trade brings it in and shows it to a user, and if it meets the program's selection criteria it is part of the next cycle. Anything else is stored unmatched and shown to a user. It is never dropped. |
| A late or corrected file arrives after approval | Data Source stores and stamps it. The approved cycle does not change; a correction starts a new cycle by an explicit user action. |

## Decisions

All six decisions are settled, each as recommended. Later documents build on them.

1. **Do pre-trades go out before or after approval?** Decided: after approval. That makes approval the release gate, and what was approved is exactly what was sent.
2. **May a cycle complete when some balances are blocked?** Decided: yes, with the blocked count shown on the run and a warning at approval, so one bad account does not stop a whole program.
3. **Can a cycle be rerun before approval?** Decided: yes. A rerun replaces the unapproved results, and the cycle record notes that it happened. After approval the answer is no, as decided.
4. **How are failed and skipped cycles recorded?** Decided: as an outcome with a reason on the cycle record, not as extra stages, so the three stages stay as decided. Skipping and deleting are explicit user actions on an open cycle.
5. **Who may approve?** Decided: a separate approve permission held in Identity, which Exposure Management checks before it records the approval.
6. **How should the simulator behave?** Decided: a small separate tool kept with the demo material, not in any service. It returns full fills by default and can be set to return partial fills, rejections or late executions, so the demo shows the unhappy paths too.
