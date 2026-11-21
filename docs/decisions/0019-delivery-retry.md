# 0019 Delivery retry

Status: proposed, for the owner's review. Resolves the recorded gap "delivery is at-least-once with per-event retry only through the next drain". Owner answers: a stuck event holds that tenant's later events from the same service; 5 tries, doubling from 1 minute.

## The problem
The dispatcher stopped the whole drain at the first handler that threw. The event stayed first in its service's queue, so every tenant's later events from that service waited behind it, with no count of tries, no record of the error and no way to see it.

## Decision
- **Tries.** A failed delivery is recorded (tries so far, last error) and tried again after a wait: 1, 2, 4, 8 minutes after the 1st to 4th failure. The 5th failure marks the event **stuck**; it is not tried again by itself. About 15 minutes in all. The numbers are one constant in `app/src/dispatch.ts`.
- **Order.** Per tenant and service, nothing is delivered behind an event that is waiting or stuck, so a tenant's events keep their order. Other tenants, and other services, carry on. (A tenant's events from different services were never ordered against each other.)
- **A drain no longer throws on one bad event.** It records the failure and goes on; it returns the number delivered. It still throws if events keep being written for 25 rounds.
- **Seeing and retrying.** `deliveryProblems(app)` lists every undelivered event that has failed (service, tenant, type, tries, last error, next try or stuck time). `retryStuckEvent(app, service, eventId)` starts a stuck event's tries again. These are functions only: no screen and no permission model yet (recorded in STATUS).
- **The wait starts at the failure.** The dispatcher reads the clock again when it records a failure, so a handler that takes 70 seconds to fail does not use up the minute (review of this PR).
- **One write.** The count and the retry time or stuck state are set in a single `UPDATE`, and a `CHECK` constraint on each outbox refuses a counted, undelivered failure that is neither waiting nor stuck. A stop can therefore never leave a fifth failure eligible for a sixth delivery, or an earlier failure without its wait (review of this PR). If the write itself is lost, the failure is simply not counted and the event is delivered again, which at-least-once already allows.
- **Still at-least-once.** A handler that did its work and then failed is run again, as before; every handler is already safe to repeat.

## What changed
Each service's outbox table gains `attempts`, `last_error`, `retry_at`, `stuck_at` and an index (migrations `*_outbox_retry`), and its outbox API gains `recordFailure`, `problems` and `retryStuck`; `pending` takes the clock and leaves out events that are not due or are held. The dispatcher's `drain` takes `{ now }` so tests can move time. The retry state lives in each service's own outbox, so no service touches another's tables.

## Tests
One database test walks the waits (1, 2, 4, 8 minutes, nothing earlier), the 5th failure, the stuck event left alone, the hold on its own tenant only, operator retry, and delivery in order afterwards. Another test advances the clock 70 seconds during a delivery and checks the event is ineligible 59 seconds after the failure and eligible at 60; reading the clock once per drain fails it. A further test reads the table after each of five failures (wait kept, then stuck, never eligible again) and shows the database refusing the old half-written state; restoring the two-step write fails both. Mutations that remove the hold, the doubling, or the off-by-one on the 5th try fail the first test. The existing "failed status read" test now expects a recorded failure and a later retry instead of a thrown drain.

## Not done, and why (for you to decide)
- **An operator screen or API with roles.** ~~Who may retry (Platform Ops, a tenant admin) is a permission choice; not made here.~~ Done: decision 0030 adds `operations:manage-events` (TREASURY_ADMIN, platform role) and the guarded functions in `app/src/operations.ts`. The screen/API themselves are still not built (B).
- **Alerts** when an event becomes stuck.
- **Retrying a stuck event for every tenant at once**, and skipping (discarding) a poison event: skipping loses data, so it is left out.
