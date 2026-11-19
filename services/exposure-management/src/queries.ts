// The questions Exposure Management answers.
import { asOfDate, cycleId, programId, type AsOfDate, type TenantId } from "@shared/kernel";
import type { Cycle, CycleSummary, ExposureManagementQuestions, ProgramSettings, Schedule } from "../contract/index.ts";
import { q, type Db, type Queryable } from "./db.ts";
import { scheduledAsOf } from "./rules.ts";

const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

export async function settingsOn(db: Queryable, tenant: TenantId, program: string, asOf: string): Promise<ProgramSettings | null> {
  const r = await q(db)
    .selectFrom("program_settings as s")
    .innerJoin("programs as p", (j) => j.onRef("p.tenant_id", "=", "s.tenant_id").onRef("p.program_id", "=", "s.program_id"))
    .select(["s.program_id", "s.valid_from", "s.netting_level", "s.bucket_scheme", "s.schedule", "p.program_type"])
    .where("s.tenant_id", "=", tenant).where("s.program_id", "=", program).where("s.valid_from", "<=", asOf)
    .where((eb) => eb.or([eb("s.valid_to", "is", null), eb("s.valid_to", ">", asOf)])).executeTakeFirst();
  if (!r) return null;
  return {
    programId: programId(r.program_id), type: r.program_type, nettingLevel: r.netting_level, bucketScheme: json(r.bucket_scheme),
    schedule: r.schedule === null ? null : json<Schedule>(r.schedule), validFrom: asOfDate(r.valid_from),
  };
}

type CycleRow = Awaited<ReturnType<typeof loadRows>>[number];
const loadRows = (db: Queryable, tenant: TenantId) => q(db).selectFrom("cycles").selectAll().where("tenant_id", "=", tenant).execute();

const summary = (r: CycleRow): CycleSummary => ({
  cycleId: cycleId(r.cycle_id), programId: programId(r.program_id), asOf: r.as_of as AsOfDate, stage: r.stage, outcome: r.outcome, outcomeReason: r.outcome_reason,
  rerunCount: r.rerun_count, approvedAt: r.approved_at?.toISOString() ?? null, approvedBy: r.approved_by, initiatedBy: r.initiated_by, initiatedAt: r.initiated_at.toISOString(),
});

export function exposureManagementQuestions(db: Db): ExposureManagementQuestions {
  return {
    async programCatalog(tenant) {
      const rows = await q(db).selectFrom("programs").select(["program_id", "name", "program_type", "enabled"]).where("tenant_id", "=", tenant).orderBy("program_id").execute();
      return rows.map((r) => ({ programId: programId(r.program_id), name: r.name, type: r.program_type, enabled: r.enabled }));
    },

    programSettings: (tenant, program, asOf) => settingsOn(db, tenant, program, asOf),

    async getCycle(tenant, id): Promise<Cycle | null> {
      const r = await q(db).selectFrom("cycles").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", id).executeTakeFirst();
      if (!r) return null;
      const history = await q(db).selectFrom("cycle_history").select(["kind", "by_who", "at", "note"]).where("tenant_id", "=", tenant).where("cycle_id", "=", id).orderBy("seq").execute();
      const settings = json<Omit<ProgramSettings, "programId" | "type"> & { programId: string; type: ProgramSettings["type"] }>(r.settings);
      return {
        ...summary(r),
        settings: { ...settings, programId: programId(settings.programId), validFrom: asOfDate(settings.validFrom) },
        history: history.map((h) => ({ kind: h.kind, by: h.by_who, at: h.at.toISOString(), note: h.note })),
      };
    },

    async cycles(tenant, filter) {
      let sel = q(db).selectFrom("cycles").selectAll().where("tenant_id", "=", tenant);
      if (filter?.programId) sel = sel.where("program_id", "=", filter.programId);
      if (filter?.open === true) sel = sel.where("outcome", "is", null).where("approved_at", "is", null);
      if (filter?.open === false) sel = sel.where((eb) => eb.or([eb("outcome", "is not", null), eb("approved_at", "is not", null)]));
      const rows = await sel.orderBy("initiated_at", "desc").orderBy("cycle_id").limit(Math.min(Math.max(filter?.limit ?? 200, 1), 1000)).execute();
      return rows.map(summary);
    },

    async dueCycles(tenant, today) {
      const programs = await q(db).selectFrom("programs").select("program_id").where("tenant_id", "=", tenant).where("enabled", "=", true).orderBy("program_id").execute();
      const out: { programId: ReturnType<typeof programId>; asOf: AsOfDate }[] = [];
      for (const p of programs) {
        const s = await settingsOn(db, tenant, p.program_id, today);
        const asOf = s ? scheduledAsOf(s.schedule, today) : null;
        if (asOf === null) continue;
        const clash = await q(db).selectFrom("cycles").select("cycle_id").where("tenant_id", "=", tenant).where("program_id", "=", p.program_id)
          .where((eb) => eb.or([eb("as_of", "=", asOf), eb.and([eb("outcome", "is", null), eb("approved_at", "is", null)])])).limit(1).executeTakeFirst();
        if (!clash) out.push({ programId: programId(p.program_id), asOf: asOfDate(asOf) });
      }
      return out;
    },
  };
}
