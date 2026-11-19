// What Data Source needs from other services, named here so it can be handed in. It is the published contract, nothing more.
import type { BatchStatus } from "../contract/index.ts";
import type { MasterDataQuestions } from "@services/master-data/contract";

export type MasterDataQuestionsLike = Pick<MasterDataQuestions, "getEntities" | "getAccounts" | "hierarchyPaths" | "accountsUnderNode">;
export type { BatchStatus };
