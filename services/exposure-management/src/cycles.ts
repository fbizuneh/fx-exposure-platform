// The cycle: start, run events from Exposure Analysis, rerun, skip, delete and approve. Every change to a cycle is
// one transaction with its history line and its event. Each handler of an outside event is safe to repeat.
import { sql } from "kysely";
import { asOfDate, cycleId as toCycleId, programId as toProgramId, type CycleId, type TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { require_, who, type IdentityPort } from "./access.ts";
import { q, type Db, type Queryable, type Tx } from "./db.ts";
import { recordChange } from "./change-record.ts";
import { announce } from "./outbox.ts";
import { settingsOn } from "./queries.ts";
import { realDate } from "./rules.ts";
import { randomUUID } from "./outbox.ts";

/** The cycle cannot take this step as it stands. */
export class CycleRefused extends Error {}

type HistoryKind = "INITIATED" | "RUN_STARTED" | "RUN_FINISHED" | "RERUN" | "SKIPPED" | "DELETED" | "EXPOSURE_APPROVED" | "APPROVED";

/** What Exposure Analysis announces. Its contract will define these with the same fields. */
export interface RunEvent {
  readonly tenantId: TenantId;
  readonly cycleId: string;
  readonly runId: string;
}

async function note(tx: Queryable, tenant: TenantId, cycle: string, kind: HistoryKind, by: string | null, text: string | null = null) {
  const last = await q(tx).selectFrom("cycle_history").select("seq").where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).orderBy("seq", "desc").limit(1).executeTakeFirst();
  await q(tx).insertInto("cycle_history").values({ tenant_id: tenant, cycle_id: cycle, seq: (last?.seq ?? 0) + 1, kind, by_who: by, note: text }).execute();
}

const isOpen = (c: { outcome: string | null; approved_at: Date | null }) => c.outcome === null && c.approved_at === null;

export function cycleCommands(db: Db, access: IdentityPort, clock: () => Date) {
  const lock = (tx: Tx, tenant: TenantId, cycle: string) =>
    q(tx).selectFrom("cycles").selectAll().where("tenant_id", "=", tenant).where("cycle_id", "=", cycle).forUpdate().executeTakeFirst();

  async function find(tenant: TenantId, id: string) {
    const c = await q(db).selectFrom("cycles").select("program_id").where("tenant_id", "=", tenant).where("cycle_id", "=", id).executeTakeFirst();
    if (!c) throw new CycleRefused("cycle not found");
    return toProgramId(c.program_id);
  }

  async function startCycle(input: { tenantId: TenantId; programId: string; asOf: string; actor: Actor }): Promise<CycleId> {
    const tenant = input.tenantId;
    if (!realDate(input.asOf)) throw new CycleRefused("as-of date must be a real date written YYYY-MM-DD");
    await require_(access, tenant, input.actor, "cycle:initiate", toProgramId(input.programId));
    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant}:${input.programId}:cycles`}))`.execute(tx);
      const program = await q(tx).selectFrom("programs").select("enabled").where("tenant_id", "=", tenant).where("program_id", "=", input.programId).executeTakeFirst();
      if (!program) throw new CycleRefused(`program ${input.programId} is not defined`);
      if (!program.enabled) throw new CycleRefused(`program ${input.programId} is disabled`);
      if (input.asOf > clock().toISOString().slice(0, 10)) throw new CycleRefused(`as-of date ${input.asOf} is in the future`);
      const settings = await settingsOn(tx, tenant, input.programId, input.asOf);
      if (!settings) throw new CycleRefused(`program ${input.programId} has no settings in force on ${input.asOf}`);
      const open = await q(tx).selectFrom("cycles").select(["cycle_id", "as_of"]).where("tenant_id", "=", tenant).where("program_id", "=", input.programId)
        .where("outcome", "is", null).where("approved_at", "is", null).executeTakeFirst();
      if (open) throw new CycleRefused(`program ${input.programId} already has an open cycle for ${open.as_of}; approve, skip or delete it first`);

      const id = randomUUID();
      await q(tx).insertInto("cycles").values({
        tenant_id: tenant, cycle_id: id, program_id: input.programId, as_of: input.asOf, stage: "INITIATED", outcome: null, outcome_reason: null,
        settings: JSON.stringify(settings), current_run_id: null, approved_at: null, approved_by: null, initiated_by: who(input.actor),
      }).execute();
      await note(tx, tenant, id, "INITIATED", who(input.actor));
      await announce(tx, { type: "exposure-management.cycle-initiated", tenantId: tenant, cycleId: toCycleId(id), programId: toProgramId(input.programId), asOf: asOfDate(input.asOf) });
      await recordChange(tx, { tenantId: tenant, programId: toProgramId(input.programId), actor: who(input.actor), action: "cycle.started", targetType: "cycle", targetId: id, fields: [] });
      return toCycleId(id);
    });
  }

  /** From Exposure Analysis: a run began. The cycle moves to in progress and remembers which run. */
  async function onRunStarted(e: RunEvent): Promise<boolean> {
    return db.transaction().execute(async (tx) => {
      const c = await lock(tx, e.tenantId, e.cycleId);
      if (!c || !isOpen(c)) return false;
      if (c.current_run_id === e.runId) return false; // a repeat
      if (c.stage !== "INITIATED") return false; // a run is already going, or the cycle is complete
      await q(tx).updateTable("cycles").set({ stage: "IN_PROGRESS", current_run_id: e.runId }).where("tenant_id", "=", e.tenantId).where("cycle_id", "=", e.cycleId).execute();
      await note(tx, e.tenantId, e.cycleId, "RUN_STARTED", null, e.runId);
      return true;
    });
  }

  /** From Exposure Analysis: a run finished. It counts only if it is the run that started. */
  async function onRunFinished(e: RunEvent): Promise<boolean> {
    return db.transaction().execute(async (tx) => {
      const c = await lock(tx, e.tenantId, e.cycleId);
      if (!c || !isOpen(c) || c.stage !== "IN_PROGRESS" || c.current_run_id !== e.runId) return false;
      await q(tx).updateTable("cycles").set({ stage: "COMPLETED" }).where("tenant_id", "=", e.tenantId).where("cycle_id", "=", e.cycleId).execute();
      await note(tx, e.tenantId, e.cycleId, "RUN_FINISHED", null, e.runId);
      await announce(tx, { type: "exposure-management.cycle-completed", tenantId: e.tenantId, cycleId: toCycleId(e.cycleId), programId: toProgramId(c.program_id) });
      return true;
    });
  }

  /** Run the cycle again before approval. The unapproved results are replaced and the record notes it. */
  async function rerunCycle(input: { tenantId: TenantId; cycleId: string; actor: Actor }): Promise<void> {
    const program = await find(input.tenantId, input.cycleId);
    await require_(access, input.tenantId, input.actor, "cycle:initiate", program);
    await db.transaction().execute(async (tx) => {
      const c = await lock(tx, input.tenantId, input.cycleId);
      if (!c) throw new CycleRefused("cycle not found");
      if (c.approved_at !== null) throw new CycleRefused("an approved cycle cannot be rerun; start a new cycle for a correction");
      if (c.exposure_approved_at !== null) throw new CycleRefused("the exposure is approved, so it cannot be recalculated; skip the cycle and start a new one for a correction");
      if (c.outcome !== null) throw new CycleRefused(`the cycle was ${c.outcome.toLowerCase()}`);
      if (c.stage === "IN_PROGRESS") throw new CycleRefused("a run is in progress; wait for it to finish");
      await q(tx).updateTable("cycles").set({ stage: "INITIATED", current_run_id: null, rerun_count: c.rerun_count + 1 }).where("tenant_id", "=", input.tenantId).where("cycle_id", "=", input.cycleId).execute();
      await note(tx, input.tenantId, input.cycleId, "RERUN", who(input.actor), `rerun ${c.rerun_count + 1}`);
      await announce(tx, { type: "exposure-management.cycle-initiated", tenantId: input.tenantId, cycleId: toCycleId(input.cycleId), programId: toProgramId(c.program_id), asOf: asOfDate(c.as_of) });
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(c.program_id), actor: who(input.actor), action: "cycle.rerun", targetType: "cycle", targetId: input.cycleId, fields: [] });
    });
  }

  async function close(kind: "SKIPPED" | "DELETED", input: { tenantId: TenantId; cycleId: string; reason: string; actor: Actor }): Promise<void> {
    if (typeof input.reason !== "string" || input.reason.trim() === "") throw new CycleRefused(`a reason is required to ${kind === "SKIPPED" ? "skip" : "delete"} a cycle`);
    const program = await find(input.tenantId, input.cycleId);
    await require_(access, input.tenantId, input.actor, "cycle:skip", program);
    await db.transaction().execute(async (tx) => {
      const c = await lock(tx, input.tenantId, input.cycleId);
      if (!c) throw new CycleRefused("cycle not found");
      if (c.approved_at !== null) throw new CycleRefused("an approved cycle cannot be skipped or deleted");
      if (c.outcome !== null) throw new CycleRefused(`the cycle was already ${c.outcome.toLowerCase()}`);
      await q(tx).updateTable("cycles").set({ outcome: kind, outcome_reason: input.reason.trim() }).where("tenant_id", "=", input.tenantId).where("cycle_id", "=", input.cycleId).execute();
      await note(tx, input.tenantId, input.cycleId, kind, who(input.actor), input.reason.trim());
      await announce(tx, {
        type: kind === "SKIPPED" ? "exposure-management.cycle-skipped" : "exposure-management.cycle-deleted",
        tenantId: input.tenantId, cycleId: toCycleId(input.cycleId), programId: toProgramId(c.program_id),
      });
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(c.program_id), actor: who(input.actor), action: kind === "SKIPPED" ? "cycle.skipped" : "cycle.deleted", targetType: "cycle", targetId: input.cycleId, fields: ["reason"] });
    });
  }

  /**
   * Approve Exposure: locks the exact run that has just completed. From here the cycle cannot be recalculated, and recommendations made
   * from this run can be decided; approving the cycle (a separate, later gate) is what releases any pre-trades.
   */
  async function approveExposure(input: { tenantId: TenantId; cycleId: string; actor: Actor }): Promise<void> {
    const program = await find(input.tenantId, input.cycleId);
    await require_(access, input.tenantId, input.actor, "exposure:approve", program);
    await db.transaction().execute(async (tx) => {
      const c = await lock(tx, input.tenantId, input.cycleId);
      if (!c) throw new CycleRefused("cycle not found");
      if (c.approved_at !== null) throw new CycleRefused("the cycle is already approved");
      if (c.outcome !== null) throw new CycleRefused(`the cycle was ${c.outcome.toLowerCase()}`);
      if (c.exposure_approved_at !== null) throw new CycleRefused("the exposure is already approved");
      if (c.stage !== "COMPLETED" || c.current_run_id === null) throw new CycleRefused("the exposure can be approved once its run has completed");
      await q(tx).updateTable("cycles").set({ exposure_approved_at: clock(), exposure_approved_by: who(input.actor), exposure_approved_run_id: c.current_run_id }).where("tenant_id", "=", input.tenantId).where("cycle_id", "=", input.cycleId).execute();
      await note(tx, input.tenantId, input.cycleId, "EXPOSURE_APPROVED", who(input.actor), `run ${c.current_run_id}`);
      await announce(tx, { type: "exposure-management.exposure-approved", tenantId: input.tenantId, cycleId: toCycleId(input.cycleId), programId: toProgramId(c.program_id), runId: c.current_run_id });
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(c.program_id), actor: who(input.actor), action: "exposure.approved", targetType: "cycle", targetId: input.cycleId, fields: [] });
    });
  }

  async function approveCycle(input: { tenantId: TenantId; cycleId: string; actor: Actor }): Promise<void> {
    const program = await find(input.tenantId, input.cycleId);
    await require_(access, input.tenantId, input.actor, "cycle:approve", program);
    await db.transaction().execute(async (tx) => {
      const c = await lock(tx, input.tenantId, input.cycleId);
      if (!c) throw new CycleRefused("cycle not found");
      if (c.approved_at !== null) throw new CycleRefused("the cycle is already approved");
      if (c.outcome !== null) throw new CycleRefused(`the cycle was ${c.outcome.toLowerCase()}`);
      if (c.stage !== "COMPLETED") throw new CycleRefused("only a completed cycle can be approved");
      if (c.exposure_approved_at === null) throw new CycleRefused("approve the exposure before approving the cycle");
      await q(tx).updateTable("cycles").set({ approved_at: clock(), approved_by: who(input.actor) }).where("tenant_id", "=", input.tenantId).where("cycle_id", "=", input.cycleId).execute();
      await note(tx, input.tenantId, input.cycleId, "APPROVED", who(input.actor));
      await announce(tx, { type: "exposure-management.cycle-approved", tenantId: input.tenantId, cycleId: toCycleId(input.cycleId), programId: toProgramId(c.program_id) });
      await recordChange(tx, { tenantId: input.tenantId, programId: toProgramId(c.program_id), actor: who(input.actor), action: "cycle.approved", targetType: "cycle", targetId: input.cycleId, fields: [] });
    });
  }

  return {
    startCycle,
    onRunStarted,
    onRunFinished,
    rerunCycle,
    skipCycle: (input: { tenantId: TenantId; cycleId: string; reason: string; actor: Actor }) => close("SKIPPED", input),
    deleteCycle: (input: { tenantId: TenantId; cycleId: string; reason: string; actor: Actor }) => close("DELETED", input),
    approveExposure,
    approveCycle,
  };
}
