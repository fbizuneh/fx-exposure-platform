// Events handled once: the mark is written in the caller's transaction, so a delivery twice changes nothing.
import type { TenantId } from "@shared/kernel";
import { q, type Queryable } from "./db.ts";

/** True the first time an event is seen. */
export async function firstTime(tx: Queryable, tenant: TenantId, eventId: string): Promise<boolean> {
  const r = await q(tx).insertInto("processed_events").values({ tenant_id: tenant, event_id: eventId }).onConflict((oc) => oc.doNothing()).executeTakeFirst();
  return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
}
