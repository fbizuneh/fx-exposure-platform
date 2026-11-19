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

/** Events not yet delivered, oldest first. */
export async function pendingEvents(db: Db, limit = 100): Promise<IdentityEvents[]> {
  const rows = await q(db)
    .selectFrom("outbox")
    .select("payload")
    .where("published_at", "is", null)
    .orderBy("created_at")
    .orderBy("event_id")
    .limit(limit)
    .execute();
  return rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as IdentityEvents);
}

/** Marks events delivered. Safe to call twice. */
export async function markPublished(db: Db, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await q(db).updateTable("outbox").set({ published_at: new Date() }).where("event_id", "in", [...eventIds]).where("published_at", "is", null).execute();
}
