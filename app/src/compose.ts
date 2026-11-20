// Builds every service over one database server, each in its own schema, and hands each the others' questions it needs.
// This is the only place services meet; none of them imports another's code, only its contract.
import type { Actor } from "@services/identity/contract";
import { connect as connectAudit, createAudit } from "../../services/audit/src/index.ts";
import { connect as connectDataSource, createDataSource } from "../../services/data-source/src/index.ts";
import { connect as connectExposureAnalysis, createExposureAnalysis } from "../../services/exposure-analysis/src/index.ts";
import { connect as connectExposureManagement, createExposureManagement } from "../../services/exposure-management/src/index.ts";
import { connect as connectFxRate, createFxRate } from "../../services/fx-rate/src/index.ts";
import { connect as connectFxTrade, createFxTrade } from "../../services/fx-trade/src/index.ts";
import { connect as connectHedgeRecommendation, createHedgeRecommendation } from "../../services/hedge-recommendation/src/index.ts";
import { connect as connectIdentity, createIdentity } from "../../services/identity/src/index.ts";
import { connect as connectMasterData, createMasterData } from "../../services/master-data/src/index.ts";

/** The actor that starts scheduled cycles. */
export const SCHEDULER: Actor = { kind: "platform", platformUserId: "scheduler" as never };

export function composeApp(connectionString: string, now: () => Date = () => new Date()) {
  const dbs = {
    audit: connectAudit(connectionString),
    identity: connectIdentity(connectionString),
    masterData: connectMasterData(connectionString),
    fxRate: connectFxRate(connectionString),
    dataSource: connectDataSource(connectionString),
    exposureManagement: connectExposureManagement(connectionString),
    exposureAnalysis: connectExposureAnalysis(connectionString),
    fxTrade: connectFxTrade(connectionString),
    hedgeRecommendation: connectHedgeRecommendation(connectionString),
  };
  const identity = createIdentity(dbs.identity);
  const audit = createAudit(dbs.audit, { access: identity.questions }, { now });
  const masterData = createMasterData(dbs.masterData);
  const fxRate = createFxRate(dbs.fxRate, { now });
  const dataSource = createDataSource(dbs.dataSource, { masterData: masterData.questions, now });
  const exposureManagement = createExposureManagement(dbs.exposureManagement, { access: identity.questions, now });
  const fxTrade = createFxTrade(dbs.fxTrade, { access: identity.questions, masterData: masterData.questions, management: exposureManagement.questions }, { now });
  const exposureAnalysis = createExposureAnalysis(dbs.exposureAnalysis, {
    management: exposureManagement.questions,
    dataSource: dataSource.questions,
    masterData: masterData.questions,
    rates: fxRate.questions,
    trades: fxTrade.questions,
    now,
  });
  const hedgeRecommendation = createHedgeRecommendation(dbs.hedgeRecommendation, {
    access: identity.questions,
    management: exposureManagement.questions,
    analysis: exposureAnalysis.questions,
    masterData: masterData.questions,
    rates: fxRate.questions,
    preTrades: fxTrade.questions,
    createPreTrades: fxTrade.commands.createPreTrades,
  }, { now });
  return {
    audit, identity, masterData, fxRate, dataSource, exposureManagement, exposureAnalysis, fxTrade, hedgeRecommendation,
    async close(): Promise<void> {
      await Promise.all(Object.values(dbs).map((d) => d.destroy()));
    },
  };
}
export type App = ReturnType<typeof composeApp>;
