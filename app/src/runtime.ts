// Starts everything one process needs: migrations, the services, the timer loops and the HTTP server. Decision 0023.
import type http from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Actor } from "@services/identity/contract";
import { migrate } from "../../scripts/migrate.mjs";
import { composeApp, type App } from "./compose.ts";
import type { Config } from "./config.ts";
import { createHttpServer, type Route } from "./http.ts";
import type { Logger } from "./log.ts";
import { checkReady } from "./ready.ts";
import { createLoop, cycleTick, deliveryTick, newStats, type Loop, type Stats } from "./ticks.ts";

/** Shutdown could not finish inside its deadline (for example a stalled query holds a connection). */
export class ShutdownTimedOut extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`shutdown did not finish within ${deadlineMs} ms`);
    this.deadlineMs = deadlineMs;
  }
}

export interface Runtime {
  readonly app: App;
  readonly stats: Stats;
  readonly server: http.Server;
  readonly port: number;
  readonly delivery: Loop;
  readonly cycles: Loop;
  /**
   * Stops accepting requests, stops the timers, lets a running pass finish, and closes the database connections, all inside one
   * deadline (`deadlineMs`, default 20 s). If cleanup cannot finish in time it logs the timeout and rejects with ShutdownTimedOut.
   */
  shutdown(deadlineMs?: number): Promise<void>;
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function startRuntime(config: Config, log: Logger, options: { now?: () => Date; routes?: readonly Route[] } = {}): Promise<Runtime> {
  const now = options.now ?? (() => new Date());
  if (config.migrateOnStart) {
    const applied = await migrate(config.databaseUrl);
    log.info("migrations checked", { applied: applied.length });
  }
  const app = composeApp(config.databaseUrl, now);
  // Scheduled cycles are started by a real platform user, so every start is a recorded use of the platform role (decision 0001).
  const schedulerId = await app.identity.commands.ensurePlatformUser({ issuer: "platform", externalSubject: "scheduler", displayName: "Scheduler" });
  const scheduler: Actor = { kind: "platform", platformUserId: schedulerId };
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  const stats = newStats();
  const startedAt = now();
  const server = createHttpServer({ app, stats, startedAt, version: version(), ready: () => checkReady(pool), now, ...(options.routes ? { routes: options.routes } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const delivery = createLoop("delivery", config.deliveryIntervalSeconds, () => deliveryTick(app, log, stats, now), log, stats);
  const cycles = createLoop("cycles", config.cycleCheckIntervalSeconds, () => cycleTick(app, log, stats, config.timezone, scheduler, now), log, stats);
  if (config.timerEnabled) {
    delivery.start();
    cycles.start();
  }
  log.info("started", { version: version(), port, timers: config.timerEnabled, timezone: config.timezone });

  let stopped: Promise<void> | null = null;
  return {
    app, stats, server, port, delivery, cycles,
    shutdown(deadlineMs = 20_000) {
      stopped ??= (async () => {
        // New connections are refused from the first moment; idle keep-alive connections are dropped too.
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        const cleanup = (async () => {
          // Running passes get at most half the deadline, so closing the connections always has time left.
          const loopWait = Math.floor(deadlineMs / 2);
          await Promise.all([delivery.stop(loopWait), cycles.stop(loopWait)]);
          server.closeAllConnections();
          await closed;
          await Promise.all([pool.end(), app.close()]);
        })();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            log.error("shutdown timed out", { deadlineMs });
            server.closeAllConnections();
            reject(new ShutdownTimedOut(deadlineMs));
          }, deadlineMs);
        });
        try {
          await Promise.race([cleanup, timeout]);
        } finally {
          clearTimeout(timer);
          cleanup.catch(() => {}); // a late failure after the deadline has already been reported
        }
        log.info("stopped");
      })();
      return stopped;
    },
  };
}
