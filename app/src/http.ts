// The HTTP server: health, readiness and status only. The API (workstream B) adds its routes through `routes`.
import http from "node:http";
import type { App } from "./compose.ts";
import { deliveryProblems } from "./dispatch.ts";
import type { Readiness } from "./ready.ts";
import type { Stats } from "./ticks.ts";

export interface Route {
  readonly method: string;
  readonly path: string;
  handle(req: http.IncomingMessage): Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
}

export interface HttpDeps {
  readonly app: App;
  readonly stats: Stats;
  readonly startedAt: Date;
  readonly version: string;
  readonly ready: () => Promise<Readiness>;
  readonly now?: () => Date;
  readonly routes?: readonly Route[];
}

/** Counts only: no tenant names, no event contents, no row data. */
async function status(d: HttpDeps) {
  const now = (d.now ?? (() => new Date()))();
  const problems = await deliveryProblems(d.app);
  return {
    version: d.version,
    startedAt: d.startedAt.toISOString(),
    uptimeSeconds: Math.round((now.getTime() - d.startedAt.getTime()) / 1000),
    lastDelivery: d.stats.lastDelivery,
    lastCycleCheck: d.stats.lastCycleCheck,
    skippedTicks: d.stats.skipped,
    events: { waitingToRetry: problems.filter((p) => p.stuckAt === null).length, stuck: problems.filter((p) => p.stuckAt !== null).length },
  };
}

export function createHttpServer(d: HttpDeps): http.Server {
  const builtIn: Route[] = [
    { method: "GET", path: "/healthz", handle: () => ({ status: 200, body: { status: "ok" } }) },
    {
      method: "GET", path: "/readyz",
      handle: async () => {
        const r = await d.ready();
        return r.ready ? { status: 200, body: { status: "ready" } } : { status: 503, body: { status: "not ready", reason: r.reason } };
      },
    },
    { method: "GET", path: "/status", handle: async () => ({ status: 200, body: await status(d) }) },
  ];
  const routes = [...builtIn, ...(d.routes ?? [])];
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    void (async () => {
      try {
        const out = route ? await route.handle(req) : { status: 404, body: { error: "not found" } };
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
      } catch {
        // The error is not echoed: it may quote data.
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
      }
    })();
  });
}
