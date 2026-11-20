// The handshake with Exposure Management's Approve Cycle under segregation of duties (decision 0013).
//
// Deciding a recommendation (the claim that moves it from OPEN to DECIDING) and reserving an approval both take the same per-cycle lock, so they
// happen one after the other: either the claim came first and the reservation sees its decider, or the reservation came first and the claim sees it.
import { sql } from "kysely";
import type { CycleId, TenantId } from "@shared/kernel";
import { q, type Db, type Tx } from "./db.ts";

/** Held to the end of the transaction. */
export async function lockCycleDecisions(tx: Tx, tenant: TenantId, cycle: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cycle-decisions:${tenant}:${cycle}`}, 0))`.execute(tx);
}

export function approvalCommands(db: Db, clock: () => Date) {
  /** Reserves the approval, under the caller's reservation ID, for `approver` unless they have already accepted or overridden a hedge on the cycle (a decision waiting on FX Trade counts). */
  async function reserveApproval(tenant: TenantId, cycle: CycleId, approver: string, reservationId: string): Promise<{ held: boolean }> {
    return db.transaction().execute(async (tx) => {
      await lockCycleDecisions(tx, tenant, cycle);
      const decided = await q(tx).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("cycle_id", "=", cycle)
        .where("status", "in", ["ACCEPTED", "OVERRIDDEN", "DECIDING"]).where("decided_by", "=", approver).limit(1).executeTakeFirst();
      if (decided) return { held: false };
      // The caller's ID makes this safe to repeat: a second call with the same ID finds the reservation already there.
      await q(tx).insertInto("approval_holds").values({ tenant_id: tenant, hold_id: reservationId, cycle_id: cycle, approver, held_at: clock() }).onConflict((oc) => oc.columns(["tenant_id", "hold_id"]).doNothing()).execute();
      return { held: true };
    });
  }

  /** Drops one reservation; one that is already gone is not an error. */
  async function releaseApproval(tenant: TenantId, reservationId: string): Promise<void> {
    await q(db).deleteFrom("approval_holds").where("tenant_id", "=", tenant).where("hold_id", "=", reservationId).execute();
  }

  return { reserveApproval, releaseApproval };
}
