// Loaders refuse a bad file without calling the service (all or nothing). No database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asOfDate, tenantId } from "@shared/kernel";
import { BatchRefused } from "../../../services/data-source/src/index.ts";
import {
  loadAccountsFile,
  loadCalendarsFile,
  loadCurrenciesFile,
  loadEntitiesFile,
  loadExecutedFile,
  loadExposureCurrenciesFile,
  loadGlFile,
  loadHierarchyFile,
  loadRatesFile,
  parseControlFile,
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

/** App that records whether Data Source / FX Trade commands were reached. */
function trackingApp(
  submitGlBatch?: (batch: unknown) => Promise<unknown>,
): { app: App; called: { gl: boolean; executed: boolean }; lastGlBatch: unknown } {
  const called = { gl: false, executed: false };
  const state: { lastGlBatch: unknown } = { lastGlBatch: undefined };
  const boom = () => {
    throw new Error("service must not be called when the file is invalid");
  };
  return {
    called,
    get lastGlBatch() {
      return state.lastGlBatch;
    },
    app: {
      masterData: { commands: new Proxy({}, { get: () => boom }) },
      dataSource: {
        commands: {
          submitGlBatch: async (batch: unknown) => {
            called.gl = true;
            state.lastGlBatch = batch;
            if (submitGlBatch) return submitGlBatch(batch);
            return { status: "APPLIED", batchId: "b", ingestion: "COMPLETE", received: 1, included: 1, excluded: 0, blocked: 0 };
          },
        },
      },
      fxRate: { commands: new Proxy({}, { get: () => boom }) },
      fxTrade: {
        commands: {
          importExecutedTrades: async () => {
            called.executed = true;
            return { status: "APPLIED", batchId: "b", received: 1, stored: 1, unchanged: 0, blocked: 0, matched: 0, unmatched: 1 };
          },
        },
      },
    } as unknown as App,
  };
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

  it("GL: row as_of mismatch is INVALID_FILE (no service call)", async () => {
    const text = [
      "entity_code,account_number,currency,balance,debit,credit,as_of",
      "US1,1000,USD,125000.50,,,2026-03-09",
      "US1,1200,EUR,10000.00,,,2026-03-08",
      "DE1,2000,EUR,-4200.00,,,",
    ].join("\n");
    const out = await loadGlFile(app, { tenantId: tenant, text, chartCode: "MAIN", asOf, sourceSystem: "erp", by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") {
      assert.equal(out.problems.length, 1);
      assert.deepEqual(out.problems[0], {
        rowNo: 2,
        column: "as_of",
        message: "as_of differs from the batch as-of",
      });
    }
  });

  it("rates: missing observed_at", async () => {
    const text = "base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at\nEUR,USD,SPOT,SPOT,,1.08,,,,,,\n";
    const out = await loadRatesFile(app, { tenantId: tenant, text, source: "reuters", businessDate: asOf, by });
    assert.equal(out.kind, "INVALID_FILE");
  });

  it("executed: malformed quoted amount is INVALID_FILE (no service call)", async () => {
    const text = [
      "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,portfolio,hedging_program_id,pre_trade_reference,leg",
      'SIM-1,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,"10"0,USD,1090,,FORWARD,BUY,BOOK-A,BS-ENT,,',
    ].join("\n");
    const out = await loadExecutedFile(app, { tenantId: tenant, text, by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") {
      assert.ok(out.problems.some((p) => p.rowNo === 1 && (p.column === "deal_amount" || p.column === null)));
    }
  });

  it("executed: header with no required columns is INVALID_FILE (no service call)", async () => {
    const out = await loadExecutedFile(app, { tenantId: tenant, text: "foo,bar\n1,2\n", by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") {
      assert.ok(out.problems.some((p) => p.column === "trade_id" && p.rowNo === null));
      assert.ok(out.problems.some((p) => p.column === "deal_amount"));
    }
  });

  it("executed: duplicate deal_amount header is INVALID_FILE (no service call)", async () => {
    const text = [
      "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,portfolio,hedging_program_id,pre_trade_reference,leg",
      "SIM-1,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,100,200,USD,1090,,FORWARD,BUY,BOOK-A,BS-ENT,,",
    ].join("\n");
    const out = await loadExecutedFile(app, { tenantId: tenant, text, by });
    assert.equal(out.kind, "INVALID_FILE");
    if (out.kind === "INVALID_FILE") {
      assert.ok(out.problems.some((p) => p.column === "deal_amount" && p.rowNo === null && /duplicate/.test(p.message)));
    }
  });
});

describe("loaders accept distinct executed custom columns", () => {
  it("extra custom headers still reach the importer", async () => {
    const { app, called } = trackingApp();
    const text = [
      "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,portfolio,hedging_program_id,pre_trade_reference,leg,desk,book_note",
      "SIM-1,SIMFX,US1,Bank,2026-03-09,2026-06-09,EUR,1000000.0000,USD,1090000.0000,,FORWARD,BUY,BOOK-A,BS-ENT,,,DESK-A,note",
    ].join("\n");
    const out = await loadExecutedFile(app, { tenantId: tenant, text, by });
    assert.equal(out.kind, "DONE");
    assert.equal(called.executed, true);
  });
});

describe("loaders accept blank GL as_of and call the service", () => {
  it("blank optional as_of is not treated as a mismatch", async () => {
    const { app, called } = trackingApp();
    const text = "entity_code,account_number,currency,balance,debit,credit,as_of\nUS1,1000,USD,1.00,,,\n";
    const out = await loadGlFile(app, { tenantId: tenant, text, chartCode: "MAIN", asOf, sourceSystem: "erp", by });
    assert.equal(out.kind, "DONE");
    assert.equal(called.gl, true);
  });
});

describe("parseControlFile", () => {
  it("parses a valid control CSV into expectedTotals", () => {
    const out = parseControlFile("currency,row_count,sum\nUSD,2,140.50\nEUR,1,5\n");
    assert.deepEqual(out.problems, []);
    assert.deepEqual(out.rows, [
      { currency: "USD", rowCount: 2, sum: "140.50" },
      { currency: "EUR", rowCount: 1, sum: "5" },
    ]);
  });

  it("allows an empty currency for the no-currency bucket", () => {
    const out = parseControlFile("currency,row_count,sum\n,1,0\n");
    assert.deepEqual(out.problems, []);
    assert.deepEqual(out.rows, [{ currency: "", rowCount: 1, sum: "0" }]);
  });

  it("names row and column for bad values without echoing cell contents", () => {
    const marker = "BAD_SUM_MARKER_9f3a";
    const out = parseControlFile(`currency,row_count,sum\nUSD,2,${marker}\n`);
    assert.equal(out.rows.length, 0);
    assert.ok(out.problems.some((p) => p.rowNo === 1 && p.column === "sum" && /decimal/.test(p.message)));
    assert.ok(out.problems.every((p) => !p.message.includes(marker)));
  });

  it("refuses unknown, duplicate and missing columns", () => {
    const unknown = parseControlFile("currency,row_count,sum,extra\nUSD,1,1\n");
    assert.ok(unknown.problems.some((p) => p.column === "extra" && p.rowNo === null));
    const missing = parseControlFile("currency,sum\nUSD,1\n");
    assert.ok(missing.problems.some((p) => p.column === "row_count" && /missing/.test(p.message)));
    const dupCurrency = parseControlFile("currency,row_count,sum\nUSD,1,1\nUSD,2,2\n");
    assert.ok(dupCurrency.problems.some((p) => p.rowNo === 2 && p.column === "currency" && /more than once/.test(p.message)));
  });
});

describe("loadGlFile expectedTotals (D7)", () => {
  const glText = "entity_code,account_number,currency,balance,debit,credit,as_of\nUS1,1000,USD,10.00,,,2026-03-09\n";

  it("omitting expectedTotals leaves the batch field unset", async () => {
    const tracked = trackingApp();
    const out = await loadGlFile(tracked.app, {
      tenantId: tenant,
      text: glText,
      chartCode: "MAIN",
      asOf,
      sourceSystem: "erp",
      by,
    });
    assert.equal(out.kind, "DONE");
    assert.equal(tracked.called.gl, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tracked.lastGlBatch as object, "expectedTotals"),
      false,
    );
  });

  it("matching expectedTotals are passed through and yield DONE", async () => {
    const expectedTotals = [{ currency: "USD", rowCount: 1, sum: "10.00" }];
    const tracked = trackingApp();
    const out = await loadGlFile(tracked.app, {
      tenantId: tenant,
      text: glText,
      chartCode: "MAIN",
      asOf,
      sourceSystem: "erp",
      by,
      expectedTotals,
    });
    assert.equal(out.kind, "DONE");
    assert.deepEqual((tracked.lastGlBatch as { expectedTotals: unknown }).expectedTotals, expectedTotals);
  });

  it("BatchRefused from a totals mismatch is REFUSED", async () => {
    const tracked = trackingApp(async () => {
      throw new BatchRefused("batch-1", "control totals do not match: USD: received 1 rows / 10.0000, expected 1 rows / 99");
    });
    const out = await loadGlFile(tracked.app, {
      tenantId: tenant,
      text: glText,
      chartCode: "MAIN",
      asOf,
      sourceSystem: "erp",
      by,
      expectedTotals: [{ currency: "USD", rowCount: 1, sum: "99" }],
    });
    assert.equal(out.kind, "REFUSED");
    if (out.kind === "REFUSED") assert.match(out.message, /control totals do not match/);
  });
});
