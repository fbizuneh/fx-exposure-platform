// Tenant-level settings of Exposure Management (decision 0013).
import type { TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { require_, who, type IdentityPort } from "./access.ts";
import { recordChange } from "./change-record.ts";
import { q, type Db } from "./db.ts";
import { lockTenantPolicy, segregationOn } from "./queries.ts";

export function tenantCommands(db: Db, access: IdentityPort, clock: () => Date) {
  /**
   * A tenant admin switches segregation of duties on or off. Comparing, writing and recording happen under the tenant's policy lock, so each
   * actual change is recorded exactly once and a repeat (or a change that lost the race to an identical one) writes nothing at all: no row, no
   * updated_by or updated_at, no change record. The first change from the implicit default creates the row. Returns whether the setting changed.
   */
  async function setSegregationOfDuties(input: { tenantId: TenantId; enabled: boolean; actor: Actor }): Promise<boolean> {
    await require_(access, input.tenantId, input.actor, "authorization:manage");
    return db.transaction().execute(async (tx) => {
      await lockTenantPolicy(tx, input.tenantId, "exclusive");
      if ((await segregationOn(tx, input.tenantId)) === input.enabled) return false;
      await q(tx).insertInto("tenant_settings").values({ tenant_id: input.tenantId, segregation_of_duties: input.enabled, updated_by: who(input.actor), updated_at: clock() })
        .onConflict((oc) => oc.column("tenant_id").doUpdateSet({ segregation_of_duties: input.enabled, updated_by: who(input.actor), updated_at: clock() })).execute();
      await recordChange(tx, { tenantId: input.tenantId, programId: null, actor: who(input.actor), action: "tenant.segregation-of-duties-set", targetType: "tenant-setting", targetId: "segregation-of-duties", fields: ["segregationOfDuties"] });
      return true;
    });
  }
  return { setSegregationOfDuties };
}
