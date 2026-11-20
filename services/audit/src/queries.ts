import type { TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import type { AuditQuestions, AuditRecord, ChainCheck, TrailQuery } from "../contract/index.ts";
import { AccessDenied, require_, type IdentityPort } from "./access.ts";
import { GENESIS, hashOf } from "./chain.ts";
import { q, type Db } from "./db.ts";
import type { AuditDatabase } from "./schema.ts";

type Row = AuditDatabase["records"];
const fieldsOf = (v: unknown): string[] => (typeof v === "string" ? JSON.parse(v) : (v as string[]));
const toRecord = (r: Row): AuditRecord => ({
  seq: Number(r.seq), recordId: r.record_id, source: r.source, tenantId: r.tenant_id as never, programId: r.program_id as never, actor: r.actor, action: r.action,
  targetType: r.target_type, targetId: r.target_id, fields: fieldsOf(r.fields), occurredAt: r.occurred_at.toISOString(), recordedAt: r.recorded_at.toISOString(), hash: r.hash,
});

export function auditQuestions(db: Db, access: IdentityPort): AuditQuestions {
  return {
    async trail(query: TrailQuery) {
      await require_(access, query.tenantId, query.actor, "audit:read", query.programId);
      // A reader limited to some programs sees only those programs' records, whether or not they name a program (decision 0001).
      // Records that belong to no program (users, roles, tenant settings) are for readers with no program limit.
      const scope = await access.programScope(query.tenantId, query.actor);
      if (scope.restricted && scope.programs.length === 0) return { records: [], nextAfterSeq: null };
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
      let sel = q(db).selectFrom("records").selectAll().where("tenant_id", "=", query.tenantId).orderBy("seq").limit(limit + 1);
      if (query.afterSeq !== undefined) sel = sel.where("seq", ">", String(query.afterSeq));
      if (scope.restricted) sel = sel.where("program_id", "in", [...scope.programs]);
      if (query.programId !== undefined) sel = sel.where("program_id", "=", query.programId);
      if (query.by !== undefined) sel = sel.where("actor", "=", query.by);
      if (query.action !== undefined) sel = sel.where("action", "=", query.action);
      if (query.targetType !== undefined) sel = sel.where("target_type", "=", query.targetType);
      if (query.targetId !== undefined) sel = sel.where("target_id", "=", query.targetId);
      if (query.from !== undefined) sel = sel.where("occurred_at", ">=", new Date(query.from));
      if (query.to !== undefined) sel = sel.where("occurred_at", "<=", new Date(query.to));
      const rows = await sel.execute();
      const page = rows.slice(0, limit).map(toRecord);
      return { records: page, nextAfterSeq: rows.length > limit ? page[page.length - 1]!.seq : null };
    },

    async verify(tenantId: TenantId, actor: Actor): Promise<ChainCheck> {
      await require_(access, tenantId, actor, "audit:read");
      // The chain runs through every record of the tenant, so checking it tells a reader about all of them: it is for readers with no program limit.
      if ((await access.programScope(tenantId, actor)).restricted) throw new AccessDenied("audit:read", "program-restricted");
      // Records and chain head are read in one snapshot, so an append that lands while this runs cannot look like a broken chain.
      return db.transaction().setIsolationLevel("repeatable read").execute(async (tx) => {
      let prev = GENESIS;
      let expected = 1;
      let after = "0";
      for (;;) {
        const rows = await q(tx).selectFrom("records").selectAll().where("tenant_id", "=", tenantId).where("seq", ">", after).orderBy("seq").limit(500).execute();
        if (rows.length === 0) break;
        for (const r of rows) {
          const rec = toRecord(r);
          const good = rec.seq === expected && r.prev_hash === prev && r.hash === hashOf(prev, { tenantId: r.tenant_id, seq: rec.seq, recordId: r.record_id, source: r.source, programId: r.program_id, actor: r.actor, action: r.action, targetType: r.target_type, targetId: r.target_id, fields: rec.fields, occurredAt: rec.occurredAt, recordedAt: rec.recordedAt });
          if (!good) return { ok: false, checked: expected - 1, brokenAtSeq: expected };
          prev = r.hash;
          expected++;
        }
        after = rows[rows.length - 1]!.seq;
      }
      // The head must agree with the last record, or records were removed from the end.
      const head = await q(tx).selectFrom("chain_heads").selectAll().where("tenant_id", "=", tenantId).executeTakeFirst();
      const headOk = head ? Number(head.last_seq) === expected - 1 && head.last_hash === prev : expected === 1;
      return headOk ? { ok: true, checked: expected - 1, brokenAtSeq: null } : { ok: false, checked: expected - 1, brokenAtSeq: expected };
      });
    },
  };
}

export { AccessDenied };
