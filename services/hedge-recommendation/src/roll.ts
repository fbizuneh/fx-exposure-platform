// The roll dates of a cycle (decision 0021): entered per cycle, before its exposure is approved, and read when the cycle's recommendations are made.
import type { CycleId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { require_, who } from "./access.ts";
import { lockCycleDecisions } from "./approval.ts";
import { addDays } from "./calc.ts";
import { recordChange } from "./change-record.ts";
import { q, type Db } from "./db.ts";
import type { Collaborators } from "./ports.ts";
import { readPolicy } from "./queries.ts";

export class RollDatesInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the roll dates are not valid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export interface RollDatesInput {
  /** The date maturing hedges are looked for from. */
  readonly nearDate: string;
  /** The value date the maturing hedges are rolled to; left out, each group's tenor date from the policy. */
  readonly farDate?: string | null;
  /** Calendar days after the near date that maturing hedges are still picked up; left out, the policy's default. */
  readonly offsetDays?: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function rollDatesProblems(r: RollDatesInput, asOf: string, policyOffset: number): string[] {
  const out: string[] = [];
  if (!isDate(r.nearDate)) { out.push("the near date must be a date like 2026-12-15"); return out; }
  if (r.nearDate <= asOf) out.push("the near date must be after the cycle's as-of date");
  if (r.offsetDays !== undefined && r.offsetDays !== null && (!Number.isInteger(r.offsetDays) || r.offsetDays < 0 || r.offsetDays > 366)) out.push("the offset must be a whole number of days from 0 to 366");
  else if (r.farDate !== undefined && r.farDate !== null) {
    if (!isDate(r.farDate)) out.push("the far date must be a date like 2027-01-15");
    else if (r.farDate <= addDays(r.nearDate, r.offsetDays ?? policyOffset)) out.push("the far date must be after the near date plus the offset");
  }
  return out;
}

export function rollCommands(db: Db, c: Collaborators, clock: () => Date) {
  /** Enter (or replace) the roll dates of a cycle. The cycle's recommendations are made from them the next time it is run. */
  async function setRollDates(input: { tenantId: TenantId; cycleId: CycleId; actor: Actor; dates: RollDatesInput }): Promise<void> {
    const { tenantId: tenant } = input;
    const cycle = await c.management.getCycle(tenant, input.cycleId);
    if (!cycle) throw new RollDatesInvalid([`cycle ${input.cycleId} does not exist`]);
    await require_(c.access, tenant, input.actor, "hedge-policy:manage", cycle.programId);
    if (cycle.approvedAt !== null || cycle.outcome !== null || cycle.exposureApprovedAt !== null) throw new RollDatesInvalid(["the exposure is approved or the cycle is closed; roll dates can no longer change"]);
    const policy = await readPolicy(db, tenant, cycle.programId);
    if (policy.rollType !== "ADJUST_SWAP") throw new RollDatesInvalid(["the program's hedge policy does not roll; set its roll type first"]);
    const problems = rollDatesProblems(input.dates, cycle.asOf, policy.rollOffsetDays);
    if (problems.length > 0) throw new RollDatesInvalid(problems);
    const d = input.dates;
    const run = await c.analysis.currentRun(tenant, input.cycleId);
    await db.transaction().execute(async (tx) => {
      // The approval of the exposure takes this lock to check the dates and lock them for the run it approves, so an edit is wholly before it (and the approval then
      // refuses until the cycle is rerun) or wholly after it (and is refused here).
      await lockCycleDecisions(tx, tenant, input.cycleId);
      const locked = await q(tx).selectFrom("roll_locks").select("run_id").where("tenant_id", "=", tenant).where("cycle_id", "=", input.cycleId).executeTakeFirst();
      if (locked && run && locked.run_id === run.runId) throw new RollDatesInvalid(["the exposure is being approved on the current run, so its roll dates are locked; rerun the cycle first"]);
      const before = await q(tx).selectFrom("roll_parameters").select("revision").where("tenant_id", "=", tenant).where("cycle_id", "=", input.cycleId).executeTakeFirst();
      await q(tx).deleteFrom("roll_parameters").where("tenant_id", "=", tenant).where("cycle_id", "=", input.cycleId).execute();
      await q(tx).insertInto("roll_parameters").values({
        tenant_id: tenant, program_id: cycle.programId, cycle_id: input.cycleId, near_date: d.nearDate, far_date: d.farDate ?? null, offset_days: d.offsetDays ?? null, set_by: who(input.actor), set_at: clock(),
        revision: (before?.revision ?? 0) + 1,
      }).execute();
      await recordChange(tx, { tenantId: tenant, programId: cycle.programId, actor: who(input.actor), action: "roll-dates.set", targetType: "cycle", targetId: input.cycleId, fields: ["nearDate", "farDate", "offsetDays"] });
    });
  }

  /**
   * Asked by Exposure Management before it approves the exposure of a run (decision 0021). A program that rolls may be approved only when the run's recommendations were
   * made from the roll dates as they stand now; it then locks the dates for that run. A run with no groups has no recommendations and passes.
   */
  async function checkExposureApproval(tenant: TenantId, cycleId: CycleId, runId: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const cycle = await c.management.getCycle(tenant, cycleId);
    if (!cycle) return { allowed: true };
    const policy = await readPolicy(db, tenant, cycle.programId);
    if (policy.rollType !== "ADJUST_SWAP") return { allowed: true };
    const groups = await c.analysis.netExposures(tenant, runId);
    return db.transaction().execute(async (tx) => {
      await lockCycleDecisions(tx, tenant, cycleId);
      const recs = await q(tx).selectFrom("recommendations").select("roll_revision").where("tenant_id", "=", tenant).where("cycle_id", "=", cycleId).where("run_id", "=", runId).where("status", "<>", "SUPERSEDED").execute();
      if (recs.length === 0 && groups.length > 0) return { allowed: false as const, reason: "the recommendations for this run are not made yet; try again shortly" };
      const now = await q(tx).selectFrom("roll_parameters").select("revision").where("tenant_id", "=", tenant).where("cycle_id", "=", cycleId).executeTakeFirst();
      if (recs.some((r) => r.roll_revision !== (now?.revision ?? null))) return { allowed: false as const, reason: "the roll dates changed after this run's recommendations were made; rerun the cycle before approving the exposure" };
      await q(tx).deleteFrom("roll_locks").where("tenant_id", "=", tenant).where("cycle_id", "=", cycleId).execute();
      await q(tx).insertInto("roll_locks").values({ tenant_id: tenant, program_id: cycle.programId, cycle_id: cycleId, run_id: runId, locked_at: clock() }).execute();
      return { allowed: true as const };
    });
  }

  /** The approval did not happen: unlock the dates again. One already gone is not an error. */
  async function releaseExposureCheck(tenant: TenantId, cycleId: CycleId, runId: string): Promise<void> {
    await q(db).deleteFrom("roll_locks").where("tenant_id", "=", tenant).where("cycle_id", "=", cycleId).where("run_id", "=", runId).execute();
  }
  return { setRollDates, checkExposureApproval, releaseExposureCheck };
}
