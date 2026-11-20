// Takes in a change record announced by any service and adds it to the tenant's trail (decision 0012).
import type { ChangeRecordedEvent } from "../contract/index.ts";
import { GENESIS, hashOf } from "./chain.ts";
import { q, type Db } from "./db.ts";

export class RecordInvalid extends Error {}

const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 200;

export function recordCommands(db: Db, clock: () => Date) {
  /** Safe to repeat: a record with the same ID is already in the trail and nothing changes. */
  async function record(e: ChangeRecordedEvent): Promise<"RECORDED" | "DUPLICATE"> {
    const source = typeof e.type === "string" && e.type.endsWith(".change-recorded") ? e.type.slice(0, e.type.indexOf(".")) : "";
    const problems = [
      !source && "not a change record",
      !text(e.eventId) && "record ID missing", !text(e.tenantId) && "tenant missing", !text(e.actor) && "actor missing", !text(e.action) && "action missing",
      !text(e.targetType) && "target type missing", !text(e.targetId) && "target ID missing", !Array.isArray(e.fields) || !e.fields.every((f) => typeof f === "string") ? "fields must be a list of names" : false,
      Number.isNaN(Date.parse(e.occurredAt)) && "time of change missing",
    ].filter((p): p is string => typeof p === "string");
    if (problems.length > 0) throw new RecordInvalid(`change record refused: ${problems.join("; ")}`);

    const tenant = e.tenantId as string;
    return db.transaction().execute(async (tx) => {
      await q(tx).insertInto("chain_heads").values({ tenant_id: tenant, last_seq: "0", last_hash: GENESIS }).onConflict((oc) => oc.doNothing()).execute();
      const head = await q(tx).selectFrom("chain_heads").selectAll().where("tenant_id", "=", tenant).forUpdate().executeTakeFirstOrThrow(); // one writer per tenant at a time
      const have = await q(tx).selectFrom("records").select("seq").where("tenant_id", "=", tenant).where("record_id", "=", e.eventId).executeTakeFirst();
      if (have) return "DUPLICATE";
      const seq = Number(head.last_seq) + 1;
      const occurredAt = new Date(e.occurredAt).toISOString();
      const hash = hashOf(head.last_hash, { tenantId: tenant, seq, recordId: e.eventId, source, programId: e.programId, actor: e.actor, action: e.action, targetType: e.targetType, targetId: e.targetId, fields: e.fields, occurredAt });
      await q(tx).insertInto("records").values({
        tenant_id: tenant, seq: String(seq), record_id: e.eventId, source, program_id: e.programId, actor: e.actor, action: e.action, target_type: e.targetType, target_id: e.targetId,
        fields: JSON.stringify(e.fields) as never, occurred_at: new Date(occurredAt), recorded_at: clock(), prev_hash: head.last_hash, hash,
      }).execute();
      await q(tx).updateTable("chain_heads").set({ last_seq: String(seq), last_hash: hash }).where("tenant_id", "=", tenant).execute();
      return "RECORDED";
    });
  }
  return { record };
}
