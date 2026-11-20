// What Exposure Management needs from other services, named here so app/ can hand it in.
import type { CycleId, TenantId } from "@shared/kernel";

/**
 * The handshake with Hedge Recommendation for Approve Cycle under segregation of duties (decision 0013). No transaction spans the two services:
 * `reserveApproval` records, in Hedge Recommendation's own database and atomically with the check, that the approver is approving this cycle,
 * and says whether the approver has already accepted or overridden a hedge on it. While the reservation stands, that approver cannot win an accept or
 * override on the cycle. So either their decision won first and the reservation is refused, or the reservation came first and the decision is refused.
 * The reservation ID is chosen by the caller (it is the approval attempt's ID), so repeating a call is safe. `releaseApproval` drops one reservation, by that ID.
 */
export interface DecisionsPort {
  reserveApproval(tenant: TenantId, cycle: CycleId, approver: string, reservationId: string): Promise<{ readonly held: boolean }>;
  releaseApproval(tenant: TenantId, reservationId: string): Promise<void>;
  /**
   * Asked before Approve Exposure approves `runId` (decision 0021): Hedge Recommendation says whether the run's recommendations still match the roll dates, and when they do
   * locks the dates for that run. `releaseExposureCheck` unlocks them when the approval did not happen. Both are safe to repeat.
   */
  checkExposureApproval(tenant: TenantId, cycle: CycleId, runId: string): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  releaseExposureCheck(tenant: TenantId, cycle: CycleId, runId: string): Promise<void>;
}
