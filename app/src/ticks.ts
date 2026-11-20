// The two jobs the runtime repeats, and a loop that never lets a job overlap itself.
import type { TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import type { App } from "./compose.ts";
import { drain, startDueCycles } from "./dispatch.ts";
import type { Logger } from "./log.ts";

/** Today's date as YYYY-MM-DD in the given time zone. */
export function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export interface Stats {
  lastDelivery: { at: string; delivered: number; ms: number } | null;
  lastCycleCheck: { at: string; started: number; ms: number } | null;
  skipped: number;
}

export function newStats(): Stats {
  return { lastDelivery: null, lastCycleCheck: null, skipped: 0 };
}

/** Delivers the events that are due. */
export async function deliveryTick(app: App, log: Logger, stats: Stats, now: () => Date = () => new Date()): Promise<number> {
  const began = Date.now();
  const delivered = await drain(app, { now });
  const ms = Date.now() - began;
  stats.lastDelivery = { at: now().toISOString(), delivered, ms };
  if (delivered > 0) log.info("events delivered", { delivered, ms });
  else log.debug("delivery tick", { delivered, ms });
  return delivered;
}

/** Starts the cycles that are due, tenant by tenant. One tenant failing does not stop the others. */
export async function cycleTick(app: App, log: Logger, stats: Stats, timezone: string, scheduler: Actor, now: () => Date = () => new Date()): Promise<number> {
  const began = Date.now();
  const today = todayIn(timezone, now());
  let started = 0;
  const tenants: readonly TenantId[] = await app.identity.questions.activeTenants();
  for (const tenant of tenants) {
    try {
      const cycles = await startDueCycles(app, tenant, today, scheduler);
      for (const cycleId of cycles) log.info("cycle started", { tenantId: tenant, cycleId, today });
      started += cycles.length;
    } catch (err) {
      log.error("cycle check failed for a tenant", { tenantId: tenant, error: err });
    }
  }
  stats.lastCycleCheck = { at: now().toISOString(), started, ms: Date.now() - began };
  return started;
}

export interface Loop {
  /** Runs one pass now unless one is already running. Resolves when that pass is over. */
  runOnce(): Promise<void>;
  start(): void;
  /** Stops the timer and waits up to `waitMs` for a running pass. */
  stop(waitMs: number): Promise<void>;
}

/** Repeats `job` every `everySeconds`. A pass never overlaps the one before it, and an error is logged and the loop carries on. */
export function createLoop(name: string, everySeconds: number, job: () => Promise<unknown>, log: Logger, stats: Stats): Loop {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const runOnce = (): Promise<void> => {
    if (running) {
      stats.skipped++;
      log.debug("tick skipped, the last one is still running", { loop: name });
      return running;
    }
    running = (async () => {
      try {
        await job();
      } catch (err) {
        log.error("tick failed", { loop: name, error: err });
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void runOnce(), everySeconds * 1000);
      timer.unref();
    },
    async stop(waitMs) {
      if (timer) clearInterval(timer);
      timer = null;
      if (!running) return;
      await Promise.race([running, new Promise<void>((r) => setTimeout(r, waitMs))]);
    },
  };
}
