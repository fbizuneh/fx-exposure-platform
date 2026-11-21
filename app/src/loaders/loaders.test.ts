// Loaders refuse a bad file without calling the service (all or nothing). No database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asOfDate, tenantId } from "@shared/kernel";
import {
  loadAccountsFile,
  loadCalendarsFile,
  loadCurrenciesFile,
  loadEntitiesFile,
  loadExposureCurrenciesFile,
  loadGlFile,
  loadHierarchyFile,
  loadRatesFile,
} from "./index.ts";
import type { App } from "../compose.ts";

/** A stand-in that throws if any service command is reached. */
function unusedApp(): App {
  const boom = () => {
    throw new Error("service must not be called when the file is invalid");
  };
  const commands = new Proxy({}, { get: () => boom });
  return {
    masterData: { commands },
    dataSource: { commands },
    fxRate: { commands },
    fxTrade: { commands },
  } as unknown as App;
}

const tenant = tenantId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001");
const asOf = asOfDate("2026-03-09");
const by = "test";

describe("loaders INVALID_FILE (no service call)", () => {
  const app = unusedApp();

  it("entities: unknown column", async () => {
    const text = "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity,extra\nG,Acme,GROUP,,,,false,false,false,x\n";
    const out = await loadEntitiesFile(app, { tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") assert.ok(out.problems.some((p) => p.column === "extra"));
  });

  it("hierarchy: missing required column", async () => {
    const text = "code,name,classification,parent_code\nBS,Balance sheet,BALANCE_SHEET,\n";
    const out = await loadHierarchyFile(app, { tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("accounts: bad boolean", async () => {
    const text = "chart_code,account_number,name,statement_type,normal_balance,monetary_flag,fx_relevant_flag,hierarchy_node_code\nMAIN,1000,Cash,BALANCE_SHEET,DEBIT,yes,true,CASH\n";
    const out = await loadAccountsFile(app, { tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("currencies: bad code", async () => {
    const text = "code,is_ndf\nUS,false\n";
    const out = await loadCurrenciesFile(app, { tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("calendars: disagreeing weekend_days", async () => {
    const text = "currency_code,weekend_days,covered_through,holiday_date,holiday_name\nUSD,SAT|SUN,2027-12-31,2026-01-01,NY\nUSD,FRI|SAT,2027-12-31,2026-07-04,July4\n";
    const out = await loadCalendarsFile(app, { tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("exposure currencies: bad pair", async () => {
    const text = "pair,exposure_currency\nEURUSD,USD\n";
    const out = await loadExposureCurrenciesFile(app, {
      tenantId: tenant, text, sourceSystem: "md", asOf, mode: "SNAPSHOT", by, programCode: "BS-ENT",
    });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("GL: neither balance nor debit/credit", async () => {
    const text = "entity_code,account_number,currency,balance,debit,credit,as_of\nUS1,1000,USD,,,,2026-03-09\n";
    const out = await loadGlFile(app, { tenantId: tenant, text, chartCode: "MAIN", asOf, sourceSystem: "erp", by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") assert.ok(out.problems.some((p) => p.rowNo === 1));
  });

  it("rates: missing observed_at", async () => {
    const text = "base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at\nEUR,USD,SPOT,SPOT,,1.08,,,,,,\n";
    const out = await loadRatesFile(app, { tenantId: tenant, text, source: "reuters", businessDate: asOf, by });
    assert.equal(out.kind, "INVALID_FILE");
  });
});
