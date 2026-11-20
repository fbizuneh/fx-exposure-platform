// The handshake with Exposure Management's Approve Cycle under segregation of duties (decision 0013).
//
// Deciding a recommendation (the claim that moves it from OPEN to DECIDING) and reserving an approval both take the same per-cycle lock, so they
// happen one after the other: either the claim came first and the reservation sees its decider, or the reservation came first and the claim sees it.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { CycleId, TenantId } from "@shared/kernel";
import { q, type Db, type Tx } from "./db.ts";

/** Held to the end of the transaction. */
export async function lockCycleDecisions(tx: Tx, tenant: TenantId, cycle: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cycle-decisions:${tenant}:${cycle}`}, 0))`.execute(tx);
}

export function approvalCommands(db: Db, clock: () => Date) {
  /** Reserves the approval for `approver` unless they have already accepted or overridden a hedge on the cycle (a decision waiting on FX Trade counts). */
  async function reserveApproval(tenant: TenantId, cycle: CycleId, approver: string): Promise<{ held: true; holdId: string } | { held: false }> {
    return db.transaction().execute(async (tx) => {
      await lockCycleDecisions(tx, tenant, cycle);
      const decided = await q(tx).selectFrom("recommendations").select("recommendation_id").where("tenant_id", "=", tenant).where("cycle_id", "=", cycle)
        .where("status", "in", ["ACCEPTED", "OVERRIDDEN", "DECIDING"]).where("decided_by", "=", approver).limit(1).executeTakeFirst();
      if (decided) return { held: false } as const;
      const holdId = randomUUID();
      await q(tx).insertInto("approval_holds").values({ tenant_id: tenant, hold_id: holdId, cycle_id: cycle, approver, held_at: clock() }).execute();
      return { held: true, holdId } as const;
    });
  }

  /** Drops one reservation; one that is already gone is not an error. */
  async function releaseApproval(tenant: TenantId, holdId: string): Promise<void> {
    await q(db).deleteFrom("approval_holds").where("tenant_id", "=", tenant).where("hold_id", "=", holdId).execute();
  }

  return { reserveApproval, releaseApproval };
}
