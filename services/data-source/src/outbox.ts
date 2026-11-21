// Rule 5: a change and its announcement are written in one transaction. A dispatcher in app/
// reads pending events and delivers them; moving to a queue later changes only the dispatcher.
import { randomUUID } from "node:crypto";
import type { TenantId } from "@shared/kernel";
import type { DataSourceEvents } from "../contract/index.ts";
import { sql } from "kysely";
import { q, type Db, type Queryable } from "./db.ts";

type Draft<E> = E extends unknown ? Omit<E, "eventId" | "occurredAt"> : never;

export async function announce(tx: Queryable, event: Draft<DataSourceEvents>): Promise<DataSourceEvents> {
  const full = { ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() } as DataSourceEvents;
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

/** True for exactly the retry announcement this service's own `retryStuck` writes (decision 0030), never any other change record. */
const isRetryAnnouncement = (alias: "o" | "b") => sql<boolean>`(${sql.ref(`${alias}.type`)} like '%.change-recorded' and ${sql.ref(`${alias}.payload`)}->>'action' = 'event.retried')`;

/**
 * Events that may be delivered now, oldest first. Per tenant, nothing is offered behind an event that is waiting to be retried or is stuck, so a tenant's
 * order is kept while other tenants carry on (decision 0019; records from one service otherwise arrive in order, decision 0012 point 4). A retry's own
 * `event.retried` announcement is the single, narrow exception (decision 0030): it is never held behind an earlier unresolved event, and never holds a
 * later one, so it still reaches Audit even if the event it was about gets stuck again before the announcement is delivered. Every other change record,
 * J2's included, keeps the ordinary hold in both directions.
 */
export async function pendingEvents(db: Db, limit = 100, now = new Date()): Promise<DataSourceEvents[]> {
  const rows = await q(db)
    .selectFrom("outbox as o")
    .select("o.payload")
    .where("o.published_at", "is", null)
    .where("o.stuck_at", "is", null)
    .where((eb) => eb.or([eb("o.retry_at", "is", null), eb("o.retry_at", "<=", now)]))
    .where((eb) =>
      eb.or([
        isRetryAnnouncement("o"),
        eb.not(
          eb.exists(
            eb.selectFrom("outbox as b").select("b.event_id").whereRef("b.tenant_id", "=", "o.tenant_id").whereRef("b.seq", "<", "o.seq").where("b.published_at", "is", null)
              .where((e2) => e2.not(isRetryAnnouncement("b")))
              .where((e2) => e2.or([e2("b.stuck_at", "is not", null), e2("b.retry_at", ">", now)])),
          ),
        ),
      ]),
    )
    .orderBy("o.seq")
    .limit(limit)
    .execute();
  return rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as DataSourceEvents);
}

export async function markPublished(db: Db, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await q(db).updateTable("outbox").set({ published_at: new Date() }).where("event_id", "in", [...eventIds]).where("published_at", "is", null).execute();
}

export { randomUUID };

/**
 * Notes a failed delivery: tries again after a wait that doubles, and after the last allowed try marks the event stuck.
 * One statement sets the count and the retry time or stuck state together, so a stop can never leave a counted failure that is still eligible at once.
 */
export async function recordFailure(db: Db, eventId: string, error: string, now: Date, policy: RetryPolicy): Promise<"RETRYING" | "STUCK"> {
  const row = await q(db).updateTable("outbox")
    .set({
      attempts: sql`attempts + 1`,
      last_error: error.slice(0, 2000),
      retry_at: sql`CASE WHEN attempts + 1 >= ${policy.maxAttempts} THEN NULL ELSE ${now}::timestamptz + (${policy.firstDelayMs}::double precision * power(2, attempts) * interval '1 millisecond') END`,
      stuck_at: sql`CASE WHEN attempts + 1 >= ${policy.maxAttempts} THEN ${now}::timestamptz ELSE NULL END`,
    })
    .where("event_id", "=", eventId).where("published_at", "is", null).returning("stuck_at").executeTakeFirst();
  return row?.stuck_at ? "STUCK" : "RETRYING"; // no row: delivered meanwhile
}

/** Events that have failed and are not yet delivered: retrying, or stuck. */
export async function deliveryProblems(db: Db): Promise<DeliveryProblem[]> {
  const rows = await q(db).selectFrom("outbox").select(["event_id", "tenant_id", "type", "attempts", "last_error", "retry_at", "stuck_at"])
    .where("published_at", "is", null).where("attempts", ">", 0).orderBy("seq").execute();
  return rows.map((r) => ({ eventId: r.event_id, tenantId: r.tenant_id, type: r.type, attempts: r.attempts, lastError: r.last_error, retryAt: r.retry_at, stuckAt: r.stuck_at }));
}

/**
 * An operator's retry of a stuck event: its tries start again. False when the event is not stuck, or when it belongs to a
 * different tenant than `by.tenantId` (the mutation enforces this itself, not only the caller's lookup in `operations.ts`, decision 0030).
 * The reset and the retry's own `event.retried` announcement commit or fail together, so the audit trail can never come apart from the retry.
 */
export async function retryStuck(db: Db, eventId: string, by: { tenantId: TenantId; actor: string }): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const row = await q(tx).updateTable("outbox").set({ attempts: 0, retry_at: null, stuck_at: null })
      .where("event_id", "=", eventId).where("tenant_id", "=", by.tenantId).where("published_at", "is", null).where("stuck_at", "is not", null).returning("event_id").executeTakeFirst();
    if (row === undefined) return false;
    await announce(tx, {
      type: "data-source.change-recorded", tenantId: by.tenantId, programId: null, actor: by.actor,
      action: "event.retried", targetType: "stuck-event", targetId: eventId, fields: [],
    });
    return true;
  });
}
