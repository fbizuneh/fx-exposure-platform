// Rule 5: a change and its announcement are written in one transaction. A dispatcher in app/
// reads pending events and delivers them; moving to a queue later changes only the dispatcher.
import { randomUUID } from "node:crypto";
import type { ExposureManagementEvents } from "../contract/index.ts";
import { q, type Db, type Queryable } from "./db.ts";

type Draft<E> = E extends unknown ? Omit<E, "eventId" | "occurredAt"> : never;

export async function announce(tx: Queryable, event: Draft<ExposureManagementEvents>): Promise<ExposureManagementEvents> {
  const full = { ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() } as ExposureManagementEvents;
  await q(tx)
    .insertInto("outbox")
    .values({ event_id: full.eventId, tenant_id: full.tenantId, type: full.type, payload: JSON.stringify(full) })
    .execute();
  return full;
}

export async function pendingEvents(db: Db, limit = 100): Promise<ExposureManagementEvents[]> {
  const rows = await q(db).selectFrom("outbox").select("payload").where("published_at", "is", null).orderBy("seq").limit(limit).execute();
  return rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as ExposureManagementEvents);
}

export async function markPublished(db: Db, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await q(db).updateTable("outbox").set({ published_at: new Date() }).where("event_id", "in", [...eventIds]).where("published_at", "is", null).execute();
}

export { randomUUID };
