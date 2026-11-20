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

export interface Runtime {
  readonly app: App;
  readonly stats: Stats;
  readonly server: http.Server;
  readonly port: number;
  readonly delivery: Loop;
  readonly cycles: Loop;
  /** Stops the timers, lets a running pass finish (up to `waitMs`), stops accepting requests and closes the database connections. */
  shutdown(waitMs?: number): Promise<void>;
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
    shutdown(waitMs = 20_000) {
      stopped ??= (async () => {
        await Promise.all([delivery.stop(waitMs), cycles.stop(waitMs)]);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await pool.end();
        await app.close();
        log.info("stopped");
      })();
      return stopped;
    },
  };
}
