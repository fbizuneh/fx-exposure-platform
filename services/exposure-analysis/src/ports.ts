// What Exposure Analysis needs from other services, named here so it can be handed in. Each is the published contract, nothing more.
import type { DataSourceQuestions } from "@services/data-source/contract";
import type { ExposureManagementQuestions } from "@services/exposure-management/contract";
import type { FxRateQuestions } from "@services/fx-rate/contract";
import type { MasterDataQuestions } from "@services/master-data/contract";

export interface Collaborators {
  readonly management: Pick<ExposureManagementQuestions, "getCycle">;
  readonly dataSource: Pick<DataSourceQuestions, "includedBalances" | "ingestionStatus">;
  readonly masterData: Pick<MasterDataQuestions, "getEntities" | "getAccounts" | "entityWalk" | "getCurrencies">;
  readonly rates: Pick<FxRateQuestions, "getRate">;
}
