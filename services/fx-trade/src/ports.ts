// What FX Trade needs from other services, named here so it can be handed in. Each is the published contract, nothing more.
import type { ExposureManagementQuestions } from "@services/exposure-management/contract";
import type { IdentityQuestions } from "@services/identity/contract";
import type { MasterDataQuestions } from "@services/master-data/contract";

export interface Collaborators {
  readonly access: Pick<IdentityQuestions, "checkAccess">;
  readonly masterData: Pick<MasterDataQuestions, "getEntities">;
  readonly management: Pick<ExposureManagementQuestions, "programCatalog" | "getCycle">;
}
