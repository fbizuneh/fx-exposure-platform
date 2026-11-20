// Delivers each service's announcements to the services that listen, in the order they were written.
// Every handler is safe to repeat, so an event that fails stays pending and is delivered again on the next drain.
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
    case "fx-trade.pre-trade-ready":
    case "fx-trade.pre-trade-cancelled":
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

/** Delivers pending events until none are left (a delivery can write new events). Returns how many were delivered. */
export async function drain(app: App, maxRounds = 25): Promise<number> {
  const sources = [app.identity, app.masterData, app.fxRate, app.dataSource, app.exposureManagement, app.exposureAnalysis, app.fxTrade, app.hedgeRecommendation];
  let delivered = 0;
  for (let round = 0; round < maxRounds; round++) {
    let any = false;
    for (const s of sources) {
      const pending = (await s.outbox.pending(200)) as unknown as Announced[];
      for (const e of pending) {
        await deliver(app, e);
        await s.outbox.markPublished([e.eventId]);
        delivered++;
        any = true;
      }
    }
    if (!any) return delivered;
  }
  throw new Error(`events were still being written after ${maxRounds} rounds; something is announcing in a loop`);
}

/** Starts the cycles the schedule says are due today. A missed day is not made up. Returns the cycles started. */
export async function startDueCycles(app: App, tenant: TenantId, today: string, actor: Parameters<App["exposureManagement"]["commands"]["startCycle"]>[0]["actor"]): Promise<string[]> {
  const due = await app.exposureManagement.questions.dueCycles(tenant, today as never);
  const started: string[] = [];
  for (const d of due) started.push(await app.exposureManagement.commands.startCycle({ tenantId: tenant, programId: d.programId, asOf: d.asOf, actor }));
  return started;
}
