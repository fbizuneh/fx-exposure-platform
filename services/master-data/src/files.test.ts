import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAccountsFile,
  parseCalendarsFile,
  parseCurrenciesFile,
  parseEntitiesFile,
  parseExposureCurrenciesFile,
  parseHierarchyFile,
} from "./files.ts";

const ENTITIES = `code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity
G,Acme Group,GROUP,,,,false,false,false
AMER,Americas,REGION,G,,,false,false,false
US1,Acme US Inc,LEGAL_ENTITY,AMER,US,USD,true,true,true
`;

const HIERARCHY = `chart_code,code,name,classification,parent_code
MAIN,BS,Balance sheet,BALANCE_SHEET,
MAIN,ASSETS,Assets,ASSETS,BS
MAIN,CASH,Cash and equivalents,ASSETS,ASSETS
`;

const ACCOUNTS = `chart_code,account_number,name,statement_type,normal_balance,monetary_flag,fx_relevant_flag,hierarchy_node_code
MAIN,1000,Cash,BALANCE_SHEET,DEBIT,true,true,CASH
MAIN,1200,Trade receivables,BALANCE_SHEET,DEBIT,true,true,ASSETS
MAIN,1500,Inventory,BALANCE_SHEET,DEBIT,true,false,ASSETS
`;

const CURRENCIES = `code,is_ndf
USD,false
EUR,false
BRL,true
`;

const CALENDARS = `currency_code,weekend_days,covered_through,holiday_date,holiday_name
USD,SAT|SUN,2027-12-31,2026-01-01,New Year's Day
USD,SAT|SUN,2027-12-31,2026-07-04,Independence Day
AED,FRI|SAT,2027-12-31,,
`;

const EXPOSURE = `pair,exposure_currency
EUR-USD,USD
GBP-USD,USD
USD-BRL,USD
`;

test("parseEntitiesFile: valid file", () => {
  const r = parseEntitiesFile(ENTITIES);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[2], {
    code: "US1",
    name: "Acme US Inc",
    type: "LEGAL_ENTITY",
    parentCode: "AMER",
    countryCode: "US",
    functionalCurrency: "USD",
    isLegalEntity: true,
    isTreasuryEntity: true,
    isHedgeExecutionEntity: true,
  });
});

test("parseEntitiesFile: BOM and CRLF", () => {
  const text = "\uFEFF" + ENTITIES.replace(/\n/g, "\r\n");
  const r = parseEntitiesFile(text);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
});

test("parseEntitiesFile: quoted commas and blank lines", () => {
  const text = `code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity

G,"Acme, Group",GROUP,,,,false,false,false

`;
  const r = parseEntitiesFile(text);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows[0]!.name, "Acme, Group");
});

test("parseEntitiesFile: missing, duplicate and unknown columns", () => {
  const missing = parseEntitiesFile("code,name,type\nG,Acme,GROUP\n");
  assert.ok(missing.problems.some((p) => p.rowNo === null && p.column === "is_legal_entity"));
  assert.equal(missing.rows.length, 0);

  const dup = parseEntitiesFile("code,name,type,is_legal_entity,is_treasury_entity,is_hedge_execution_entity,code\nG,A,GROUP,false,false,false,X\n");
  assert.ok(dup.problems.some((p) => p.rowNo === null && p.message.includes("duplicate")));

  const unknown = parseEntitiesFile("code,name,type,is_legal_entity,is_treasury_entity,is_hedge_execution_entity,extra\nG,A,GROUP,false,false,false,x\n");
  assert.ok(unknown.problems.some((p) => p.rowNo === null && p.column === "extra"));
});

test("parseEntitiesFile: each bad value kind", () => {
  const header =
    "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity";
  const r = parseEntitiesFile(
    [
      header,
      ",Acme,GROUP,,,,false,false,false",
      "G,,GROUP,,,,false,false,false",
      "G,Acme,NOPE,,,,false,false,false",
      "G,Acme,GROUP,,usa,,false,false,false",
      "G,Acme,GROUP,,,usd,false,false,false",
      "G,Acme,GROUP,,,,yes,false,false",
    ].join("\n"),
  );
  const byCol = (c: string) => r.problems.filter((p) => p.column === c);
  assert.ok(byCol("code").some((p) => p.rowNo === 1));
  assert.ok(byCol("name").some((p) => p.rowNo === 2));
  assert.ok(byCol("type").some((p) => p.rowNo === 3));
  assert.ok(byCol("country_code").some((p) => p.rowNo === 4));
  assert.ok(byCol("functional_currency").some((p) => p.rowNo === 5));
  assert.ok(byCol("is_legal_entity").some((p) => p.rowNo === 6));
  assert.equal(r.rows.length, 0);
});

test("parseHierarchyFile: valid, BOM/CRLF, problems", () => {
  assert.equal(parseHierarchyFile(HIERARCHY).rows.length, 3);
  assert.equal(parseHierarchyFile("\uFEFF" + HIERARCHY.replace(/\n/g, "\r\n")).problems.length, 0);
  const quoted = parseHierarchyFile(`chart_code,code,name,classification,parent_code\nMAIN,BS,"Balance, sheet",BALANCE_SHEET,\n`);
  assert.equal(quoted.rows[0]!.name, "Balance, sheet");
  const bad = parseHierarchyFile(`chart_code,code,name,classification\nMAIN,BS,Balance sheet,NOPE\n`);
  assert.ok(bad.problems.some((p) => p.column === "classification" && p.rowNo === 1));
  const unknown = parseHierarchyFile(`chart_code,code,name,classification,extra\nMAIN,BS,X,ASSETS,y\n`);
  assert.ok(unknown.problems.some((p) => p.rowNo === null && p.column === "extra"));
});

test("parseAccountsFile: valid and problem kinds", () => {
  const ok = parseAccountsFile(ACCOUNTS);
  assert.equal(ok.rows.length, 3);
  assert.equal(ok.rows[0]!.monetaryFlag, true);
  const blank = parseAccountsFile(ACCOUNTS.replace(/\n/g, "\n\n"));
  assert.equal(blank.rows.length, 3);
  const bad = parseAccountsFile(
    `chart_code,account_number,name,statement_type,normal_balance,monetary_flag,fx_relevant_flag\nMAIN,1000,Cash,BALANCE_SHEET,DEBIT,TRUE,true\n`,
  );
  assert.ok(bad.problems.some((p) => p.column === "monetary_flag" && p.rowNo === 1));
  const missing = parseAccountsFile(`chart_code,account_number,name\nMAIN,1000,Cash\n`);
  assert.ok(missing.problems.some((p) => p.rowNo === null && p.column === "statement_type"));
});

test("parseCurrenciesFile: valid, BOM/CRLF, quoted, problems", () => {
  assert.deepEqual(parseCurrenciesFile(CURRENCIES).rows.map((r) => r.code), ["USD", "EUR", "BRL"]);
  assert.equal(parseCurrenciesFile("\uFEFFcode,is_ndf\r\nUSD,false\r\n").rows.length, 1);
  const bad = parseCurrenciesFile("code,is_ndf\nusd,false\nUSD,TRUE\n");
  assert.ok(bad.problems.some((p) => p.column === "code" && p.rowNo === 1));
  assert.ok(bad.problems.some((p) => p.column === "is_ndf" && p.rowNo === 2));
  const dupCol = parseCurrenciesFile("code,is_ndf,code\nUSD,false,EUR\n");
  assert.ok(dupCol.problems.some((p) => p.message.includes("duplicate")));
});

test("parseCalendarsFile: groups holidays; empty holiday row; disagreement", () => {
  const ok = parseCalendarsFile(CALENDARS);
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.rows.length, 2);
  const usd = ok.rows.find((r) => r.currencyCode === "USD")!;
  assert.deepEqual(usd.weekendDays, ["SAT", "SUN"]);
  assert.equal(usd.holidays.length, 2);
  assert.equal(usd.holidays[0]!.name, "New Year's Day");
  const aed = ok.rows.find((r) => r.currencyCode === "AED")!;
  assert.deepEqual(aed.holidays, []);

  const bom = parseCalendarsFile("\uFEFF" + CALENDARS.replace(/\n/g, "\r\n"));
  assert.equal(bom.problems.length, 0);

  const disagree = parseCalendarsFile(`currency_code,weekend_days,covered_through,holiday_date,holiday_name
USD,SAT|SUN,2027-12-31,2026-01-01,NY
USD,FRI|SAT,2027-12-31,2026-07-04,Jul
`);
  assert.ok(disagree.problems.some((p) => p.column === "weekend_days" && p.rowNo === 2));

  const covered = parseCalendarsFile(`currency_code,weekend_days,covered_through,holiday_date,holiday_name
USD,SAT|SUN,2027-12-31,2026-01-01,NY
USD,SAT|SUN,2026-12-31,2026-07-04,Jul
`);
  assert.ok(covered.problems.some((p) => p.column === "covered_through" && p.rowNo === 2));

  const badDay = parseCalendarsFile(`currency_code,weekend_days,covered_through,holiday_date,holiday_name
USD,SAT|FUN,2027-12-31,,
`);
  assert.ok(badDay.problems.some((p) => p.column === "weekend_days"));
});

test("parseExposureCurrenciesFile: valid and shape problems", () => {
  const ok = parseExposureCurrenciesFile(EXPOSURE);
  assert.equal(ok.rows.length, 3);
  const blank = parseExposureCurrenciesFile(EXPOSURE.split("\n").join("\n\n"));
  assert.equal(blank.rows.length, 3);
  const badPair = parseExposureCurrenciesFile("pair,exposure_currency\nEUR-EUR,EUR\n");
  assert.ok(badPair.problems.some((p) => p.column === "pair"));
  const notInPair = parseExposureCurrenciesFile("pair,exposure_currency\nEUR-USD,GBP\n");
  assert.ok(notInPair.problems.some((p) => p.column === "exposure_currency"));
  const unknown = parseExposureCurrenciesFile("pair,exposure_currency,note\nEUR-USD,USD,x\n");
  assert.ok(unknown.problems.some((p) => p.rowNo === null && p.column === "note"));
});

test("master-data parsers: unclosed quote and row width", () => {
  const unclosed = parseCurrenciesFile('code,is_ndf\n"USD,false\n');
  assert.equal(unclosed.rows.length, 0);
  assert.ok(unclosed.problems.some((p) => p.rowNo === 1 && p.column === "code" && /unclosed quote/.test(p.message)));

  const escaped = parseEntitiesFile(
    `code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity\nG,"Acme ""Group""",GROUP,,,,false,false,false\n`,
  );
  assert.equal(escaped.problems.length, 0);
  assert.equal(escaped.rows[0]!.name, 'Acme "Group"');

  const short = parseCurrenciesFile("code,is_ndf\nUSD\n");
  assert.equal(short.rows.length, 0);
  assert.ok(short.problems.some((p) => p.rowNo === 1 && p.column === null && /columns/.test(p.message)));

  const long = parseCurrenciesFile("code,is_ndf\nUSD,false,extra\n");
  assert.equal(long.rows.length, 0);
  assert.ok(long.problems.some((p) => p.rowNo === 1 && /columns/.test(p.message)));
});
