// What Exposure Management needs from other services, named here so app/ can hand it in.
import type { CycleId, TenantId } from "@shared/kernel";

/**
 * The handshake with Hedge Recommendation for Approve Cycle under segregation of duties (decision 0013). No transaction spans the two services:
 * `reserveApproval` records, in Hedge Recommendation's own database and atomically with the check, that the approver is approving this cycle,
 * and says whether the approver has already accepted or overridden a hedge on it. While the reservation stands, that approver cannot win an accept or
 * override on the cycle. So either their decision won first and the reservation is refused, or the reservation came first and the decision is refused.
 * `releaseApproval` drops one reservation, by the ID it returned.
 */
export interface DecisionsPort {
  reserveApproval(tenant: TenantId, cycle: CycleId, approver: string): Promise<{ readonly held: true; readonly holdId: string } | { readonly held: false }>;
  releaseApproval(tenant: TenantId, holdId: string): Promise<void>;
}
