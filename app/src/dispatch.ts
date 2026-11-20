// Delivers each service's announcements to the services that listen, in the order they were written.
// Every handler is safe to repeat, so an event that fails is tried again later, a few times, and then waits for an operator (decision 0019).
import type { TenantId } from "@shared/kernel";
import type { App } from "./compose.ts";

type Announced = { readonly type: string; readonly tenantId: TenantId; readonly eventId: string; readonly [k: string]: unknown };

async function deliver(app: App, e: Announced): Promise<void> {
  // Every service announces its change records the same way; Audit takes them all (decision 0012).
  if (e.type.endsWith(".change-recorded")) {
    await app.audit.commands.record(e as never);
    return;
  }
  switch (e.type) {
    case "identity.program-enabled":
      await app.exposureManagement.commands.onProgramEnabled(e as never);
      return;
    case "identity.program-disabled":
      await app.exposureManagement.commands.onProgramDisabled(e as never);
      return;
    case "exposure-management.program-changed": {
      // Data Source keeps a small copy of the program catalog; the event carries only the ID, so ask for the rest.
      const program = (await app.exposureManagement.questions.programCatalog(e.tenantId)).find((p) => p.programId === e.programId);
      if (program) await app.dataSource.commands.upsertProgram(e.tenantId, { programId: program.programId, type: program.type, enabled: program.enabled });
      return;
    }
    case "exposure-management.cycle-initiated":
      await app.exposureAnalysis.commands.onCycleInitiated(e as never);
      return;
    case "exposure-management.exposure-approved":
      await app.exposureAnalysis.commands.onExposureApproved(e as never); // the approved run is locked, with the trade versions it used
      return;
    case "exposure-management.cycle-approved":
      await app.exposureAnalysis.commands.onCycleApproved(e as never);
      await app.fxTrade.commands.onCycleApproved(e as never); // the release gate for pre-trades
      await app.hedgeRecommendation.commands.onCycleClosed(e as never); // what nobody decided lapses
      return;
    case "exposure-management.cycle-skipped":
    case "exposure-management.cycle-deleted":
      await app.fxTrade.commands.onCycleClosed(e as never);
      await app.hedgeRecommendation.commands.onCycleClosed(e as never);
      return;
    case "exposure-analysis.run-started":
      await app.exposureManagement.commands.onRunStarted(e as never);
      return;
    case "exposure-analysis.run-finished":
      await app.exposureManagement.commands.onRunFinished(e as never);
      await app.hedgeRecommendation.commands.onRunFinished(e as never); // recommendations from the finished run
      return;
    case "hedge-recommendation.pre-trade-created":
      // The pre-trade now has a link. FX Trade may have changed it (cancelled it) before that, when its own event found nothing to update, so reconcile from FX Trade's
      // current status. A failed read throws, so the event stays pending and is delivered again (decision 0016).
      await app.hedgeRecommendation.commands.refreshFollowUp(e.tenantId, e.preTradeId as string);
      return;
    case "fx-trade.pre-trade-ready":
    case "fx-trade.pre-trade-cancelled":
    case "fx-trade.pre-trade-fill-changed":
    case "fx-trade.executed-trade-received":
      // The follow-up status of a recommendation follows its pre-trades (a cancellation too, decision 0016); refreshing from FX Trade's current status is safe to repeat.
      if (typeof e.preTradeId === "string") await app.hedgeRecommendation.commands.refreshFollowUp(e.tenantId, e.preTradeId);
      return;
    case "data-source.batch-stamped":
    case "fx-rate.loaded":
      // New balances or rates may be what a waiting run needs.
      await app.exposureAnalysis.commands.retryWaiting(e.tenantId);
      return;
    default:
      return; // announced for others (or for later services): nothing listens yet
  }
}

/** A failed delivery is tried 5 times in all, the wait after the first failure being 1 minute and doubling (1, 2, 4, 8), then the event is stuck (decision 0019). */
export const RETRY_POLICY = { maxAttempts: 5, firstDelayMs: 60_000 } as const;

function sources(app: App) {
  return [
    ["identity", app.identity], ["master-data", app.masterData], ["fx-rate", app.fxRate], ["data-source", app.dataSource],
    ["exposure-management", app.exposureManagement], ["exposure-analysis", app.exposureAnalysis], ["fx-trade", app.fxTrade], ["hedge-recommendation", app.hedgeRecommendation],
  ] as const;
}

/**
 * Delivers the events that are due until none are left (a delivery can write new events). Returns how many were delivered.
 * A delivery that fails is recorded and tried again later; meanwhile that tenant's later events from the same service wait behind it, so their order is kept,
 * and other tenants and services carry on (decision 0019). `now` is the clock, so tests can move time.
 */
export async function drain(app: App, options: { maxRounds?: number; now?: Date } = {}): Promise<number> {
  const maxRounds = options.maxRounds ?? 25;
  const now = options.now ?? new Date();
  let delivered = 0;
  for (let round = 0; round < maxRounds; round++) {
    let any = false;
    for (const [, s] of sources(app)) {
      const pending = (await s.outbox.pending(200, now)) as unknown as Announced[];
      const failedTenants = new Set<string>(); // a failure inside this batch holds the tenant's later events in the batch too
      for (const e of pending) {
        if (failedTenants.has(e.tenantId)) continue;
        any = true;
        try {
          await deliver(app, e);
        } catch (err) {
          failedTenants.add(e.tenantId);
          await s.outbox.recordFailure(e.eventId, err instanceof Error ? err.message : String(err), now, RETRY_POLICY);
          continue;
        }
        await s.outbox.markPublished([e.eventId]);
        delivered++;
      }
    }
    if (!any) return delivered;
  }
  throw new Error(`events were still being written after ${maxRounds} rounds; something is announcing in a loop`);
}

/** An event whose delivery has failed: retrying later, or stuck and waiting for an operator. */
export interface DeliveryProblem {
  readonly service: string; readonly eventId: string; readonly tenantId: string; readonly type: string; readonly attempts: number; readonly lastError: string | null;
  readonly retryAt: Date | null; readonly stuckAt: Date | null;
}

/** Every undelivered event that has failed, across services, with its last error. */
export async function deliveryProblems(app: App): Promise<DeliveryProblem[]> {
  const all: DeliveryProblem[] = [];
  for (const [service, s] of sources(app)) for (const p of await s.outbox.problems()) all.push({ service, ...p });
  return all;
}

/** An operator's retry of a stuck event: its tries start again on the next drain. False when no such event is stuck. */
export async function retryStuckEvent(app: App, service: string, eventId: string): Promise<boolean> {
  const found = sources(app).find(([name]) => name === service);
  if (!found) throw new Error(`no service called ${service}`);
  return found[1].outbox.retryStuck(eventId);
}

/** Starts the cycles the schedule says are due today. A missed day is not made up. Returns the cycles started. */
export async function startDueCycles(app: App, tenant: TenantId, today: string, actor: Parameters<App["exposureManagement"]["commands"]["startCycle"]>[0]["actor"]): Promise<string[]> {
  const due = await app.exposureManagement.questions.dueCycles(tenant, today as never);
  const started: string[] = [];
  for (const d of due) started.push(await app.exposureManagement.commands.startCycle({ tenantId: tenant, programId: d.programId, asOf: d.asOf, actor }));
  return started;
}
