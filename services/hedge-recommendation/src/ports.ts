// What Hedge Recommendation needs from other services, named here so it can be handed in. Each is the published contract, nothing more.
import type { CycleId, TenantId } from "@shared/kernel";
import type { ExposureAnalysisQuestions } from "@services/exposure-analysis/contract";
import type { ExposureManagementQuestions } from "@services/exposure-management/contract";
import type { FxRateQuestions } from "@services/fx-rate/contract";
import type { FxTradeQuestions } from "@services/fx-trade/contract";
import type { IdentityQuestions } from "@services/identity/contract";
import type { MasterDataQuestions } from "@services/master-data/contract";

/** The recommended pre-trade handed to FX Trade; the recommendation ID makes the call safe to repeat. */
export interface PreTradeRequest {
  readonly recommendationId: string;
  readonly tradingEntityCode: string;
  readonly instrument: "FORWARD" | "NDF";
  readonly legs: readonly {
    readonly role: "SINGLE";
    readonly direction: "BUY" | "SELL";
    readonly dealCurrency: string;
    readonly dealAmount: string;
    readonly settlementCurrency: string;
    readonly settlementAmount: null;
    readonly valueDate: string;
    readonly fixingDate: string | null;
  }[];
}

export interface Collaborators {
  readonly access: Pick<IdentityQuestions, "checkAccess">;
  readonly management: Pick<ExposureManagementQuestions, "getCycle">;
  readonly analysis: Pick<ExposureAnalysisQuestions, "currentRun" | "netExposures">;
  readonly masterData: Pick<MasterDataQuestions, "getCurrencies">;
  readonly rates: Pick<FxRateQuestions, "getRate">;
  readonly preTrades: Pick<FxTradeQuestions, "getPreTrade">;
  /** FX Trade's command, handed in by app/. */
  readonly createPreTrades: (input: { tenantId: TenantId; cycleId: CycleId; items: readonly PreTradeRequest[]; by: string }) => Promise<readonly { recommendationId: string; preTradeId: string }[]>;
}
