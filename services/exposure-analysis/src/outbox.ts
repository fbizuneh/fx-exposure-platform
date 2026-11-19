// Rule 5: a change and its announcement are written in one transaction. A dispatcher in app/ delivers pending events.
import { randomUUID } from "node:crypto";
import type { ExposureAnalysisEvents } from "../contract/index.ts";
import { q, type Db, type Queryable } from "./db.ts";

type Draft<E> = E extends unknown ? Omit<E, "eventId" | "occurredAt"> : never;

export async function announce(tx: Queryable, event: Draft<ExposureAnalysisEvents>): Promise<ExposureAnalysisEvents> {
  const full = { ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() } as ExposureAnalysisEvents;
  await q(tx).insertInto("outbox").values({ event_id: full.eventId, tenant_id: full.tenantId, type: full.type, payload: JSON.stringify(full) }).execute();
  return full;
}

export async function pendingEvents(db: Db, limit = 100): Promise<ExposureAnalysisEvents[]> {
  const rows = await q(db).selectFrom("outbox").select("payload").where("published_at", "is", null).orderBy("seq").limit(limit).execute();
  return rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as ExposureAnalysisEvents);
}

export async function markPublished(db: Db, eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await q(db).updateTable("outbox").set({ published_at: new Date() }).where("event_id", "in", [...eventIds]).where("published_at", "is", null).execute();
}

export { randomUUID };
