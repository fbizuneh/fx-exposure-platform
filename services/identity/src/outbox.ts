// Rule 5: a change and its announcement are written in one transaction. A dispatcher in app/
// reads pending events and delivers them; moving to a queue later changes only the dispatcher.
import { randomUUID } from "node:crypto";
import type { IdentityEvents } from "../contract/index.ts";
import { q, type Db, type Queryable } from "./db.ts";

type NewEvent = IdentityEvents extends infer E ? (E extends IdentityEvents ? Omit<E, "eventId" | "occurredAt"> : never) : never;

/** Writes an event inside the caller's transaction. Events carry identifiers only. */
export async function announce(tx: Queryable, event: NewEvent): Promise<IdentityEvents> {
  const full = { ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() } as IdentityEvents;
  await q(tx)
    .insertInto("outbox")
    .values({ event_id: full.eventId, tenant_id: full.tenantId, type: full.type, payload: JSON.stringify(full) })
    .execute();
  return full;
}

/** What a failed delivery is allowed: how many tries, and the wait after the first (it doubles each time). Set by the dispatcher (decision 0019). */
export interface RetryPolicy { readonly maxAttempts: number; readonly firstDelayMs: number }

/** An event whose delivery has failed at least once and is not yet delivered. */
export interface DeliveryProblem {
  readonly eventId: string; readonly tenantId: string; readonly type: string; readonly attempts: number; readonly lastError: string | null;
  readonly retryAt: Date | null; readonly stuckAt: Date | null;
}

/**
 * Events that may be delivered now, oldest first. Per tenant, nothing is offered behind an event that is waiting to be retried or is stuck, so a tenant's
 * order is kept while other tenants carry on (decision 0019).
 */
export async function pendingEvents(db: Db, limit = 100, now = new Date()): Promise<IdentityEvents[]> {
  const rows = await q(db)
    .selectFrom("outbox as o")
    .select("o.payload")
    .where("o.published_at", "is", null)
    .where("o.stuck_at", "is", null)
    .where((eb) => eb.or([eb("o.retry_at", "is", null), eb("o.retry_at", "<=", now)]))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("outbox as b").select("b.event_id").whereRef("b.tenant_id", "=", "o.tenant_id").whereRef("b.seq", "<", "o.seq").where("b.published_at", "is", null)
            .where((e2) => e2.or([e2("b.stuck_at", "is not", null), e2("b.retry_at", ">", now)])),
        ),
      ),
    )
    .orderBy("o.seq")
    .limit(limit)
    .execute();
  return rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as IdentityEvents);
}

/** Marks events delivered. Safe to call twice. */
export async function markPublished(db: Db, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await q(db).updateTable("outbox").set({ published_at: new Date() }).where("event_id", "in", [...eventIds]).where("published_at", "is", null).execute();
}

/** Notes a failed delivery: tries again after a wait that doubles, and after the last allowed try marks the event stuck. */
export async function recordFailure(db: Db, eventId: string, error: string, now: Date, policy: RetryPolicy): Promise<"RETRYING" | "STUCK"> {
  const row = await q(db).updateTable("outbox").set((eb) => ({ attempts: eb("attempts", "+", 1), last_error: error.slice(0, 2000) }))
    .where("event_id", "=", eventId).where("published_at", "is", null).returning("attempts").executeTakeFirst();
  if (!row) return "RETRYING"; // delivered meanwhile
  const stuck = row.attempts >= policy.maxAttempts;
  await q(db).updateTable("outbox")
    .set(stuck ? { retry_at: null, stuck_at: now } : { retry_at: new Date(now.getTime() + policy.firstDelayMs * 2 ** (row.attempts - 1)) })
    .where("event_id", "=", eventId).where("published_at", "is", null).execute();
  return stuck ? "STUCK" : "RETRYING";
}

/** Events that have failed and are not yet delivered: retrying, or stuck. */
export async function deliveryProblems(db: Db): Promise<DeliveryProblem[]> {
  const rows = await q(db).selectFrom("outbox").select(["event_id", "tenant_id", "type", "attempts", "last_error", "retry_at", "stuck_at"])
    .where("published_at", "is", null).where("attempts", ">", 0).orderBy("seq").execute();
  return rows.map((r) => ({ eventId: r.event_id, tenantId: r.tenant_id, type: r.type, attempts: r.attempts, lastError: r.last_error, retryAt: r.retry_at, stuckAt: r.stuck_at }));
}

/** An operator's retry of a stuck event: its tries start again. False when the event is not stuck. */
export async function retryStuck(db: Db, eventId: string): Promise<boolean> {
  const row = await q(db).updateTable("outbox").set({ attempts: 0, retry_at: null, stuck_at: null })
    .where("event_id", "=", eventId).where("published_at", "is", null).where("stuck_at", "is not", null).returning("event_id").executeTakeFirst();
  return row !== undefined;
}
