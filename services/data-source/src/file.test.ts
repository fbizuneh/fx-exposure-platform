import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlFile, parseGlFile } from "./file.ts";

const HEADER = "entity_code,account_number,currency,balance,debit,credit,as_of,cost_center";
const SAMPLE = `${HEADER}
US1,1000,USD,125000.50,,,2026-03-09,CC-100
US1,1200,EUR,,10000.00,0.00,2026-03-09,CC-100
DE1,2000,EUR,-4200.00,,,2026-03-09,
`;

test("parseGlFile: valid file with balance and debit/credit rows", () => {
  const r = parseGlFile(SAMPLE);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], {
    entityCode: "US1",
    accountNumber: "1000",
    currency: "USD",
    balance: "125000.50",
    debit: null,
    credit: null,
    asOf: "2026-03-09",
    dimensions: { cost_center: "CC-100" },
  });
  assert.equal(r.rows[1]!.balance, null);
  assert.equal(r.rows[1]!.debit, "10000.00");
  assert.equal(r.rows[1]!.credit, "0.00");
  assert.deepEqual(r.rows[2]!.dimensions, {});
});

test("parseGlFile: BOM and CRLF", () => {
  const r = parseGlFile("\uFEFF" + SAMPLE.replace(/\n/g, "\r\n"));
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
});

test("parseGlFile: quoted commas and blank lines", () => {
  const ok = parseGlFile(`${HEADER}\n\nUS1,1000,USD,1000.00,,,2026-03-09,"CC,100"\n\n`);
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.rows[0]!.dimensions.cost_center, "CC,100");
});

test("parseGlFile: missing, duplicate columns; further columns are dimensions", () => {
  const missing = parseGlFile("entity_code,account_number\nUS1,1000\n");
  assert.ok(missing.problems.some((p) => p.rowNo === null && p.column === "currency"));

  const dup = parseGlFile("entity_code,account_number,currency,balance,entity_code\nUS1,1000,USD,1,X\n");
  assert.ok(dup.problems.some((p) => p.message.includes("duplicate")));

  // Unknown fixed-list columns are dimensions, not errors.
  const dims = parseGlFile("entity_code,account_number,currency,balance,project\nUS1,1000,USD,10,P1\n");
  assert.equal(dims.problems.length, 0);
  assert.equal(dims.rows[0]!.dimensions.project, "P1");
});

test("parseGlFile: both balance and debit/credit, neither, and bad values", () => {
  const both = parseGlFile(`${HEADER}\nUS1,1000,USD,10,1,0,2026-03-09,\n`);
  assert.ok(both.problems.some((p) => p.rowNo === 1 && /not both/i.test(p.message)));

  const neither = parseGlFile(`${HEADER}\nUS1,1000,USD,,,,2026-03-09,\n`);
  assert.ok(neither.problems.some((p) => p.rowNo === 1 && /required/i.test(p.message)));

  const badCcy = parseGlFile(`${HEADER}\nUS1,1000,usd,10,,,2026-03-09,\n`);
  assert.ok(badCcy.problems.some((p) => p.column === "currency" && p.rowNo === 1));

  const badDate = parseGlFile(`${HEADER}\nUS1,1000,USD,10,,,2026-13-40,\n`);
  assert.ok(badDate.problems.some((p) => p.column === "as_of" && p.rowNo === 1));

  const badBal = parseGlFile(`${HEADER}\nUS1,1000,USD,abc,,,2026-03-09,\n`);
  assert.ok(badBal.problems.some((p) => p.column === "balance" && p.rowNo === 1));

  const negDebit = parseGlFile(`${HEADER}\nUS1,1000,USD,,-1,0,2026-03-09,\n`);
  assert.ok(negDebit.problems.some((p) => p.column === "debit" && p.rowNo === 1));

  const missingEntity = parseGlFile(`${HEADER}\n,1000,USD,10,,,2026-03-09,\n`);
  assert.ok(missingEntity.problems.some((p) => p.column === "entity_code" && p.rowNo === 1));
});

test("parseGlFile: unclosed quote is a problem; valid quotes and escapes still work", () => {
  const bad = parseGlFile(`${HEADER}\nUS1,1000,USD,"100,,,2026-03-09,\n`);
  assert.equal(bad.rows.length, 0);
  assert.ok(bad.problems.some((p) => p.rowNo === 1 && p.column === "balance" && /unclosed quote/.test(p.message)));

  // Without a closing quote at EOF the decoded cell would look like a valid amount.
  const eof = parseGlFile(`${HEADER}\nUS1,1000,USD,"100`);
  assert.equal(eof.rows.length, 0);
  assert.ok(eof.problems.some((p) => p.rowNo === 1 && p.column === "balance" && /unclosed quote/.test(p.message)));

  const ok = parseGlFile(`${HEADER}\nUS1,1000,USD,"100.00",,,2026-03-09,"CC ""A"""\n`);
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.rows[0]!.balance, "100.00");
  assert.equal(ok.rows[0]!.dimensions.cost_center, 'CC "A"');
});

test("parseGlFile: text after a closing quote is refused (not decoded as 100)", () => {
  // splitCsv would decode "10"0 as 100 with an unchanged column count.
  const r = parseGlFile(`${HEADER}\nUS1,1000,USD,"10"0,,,2026-03-09,\n`);
  assert.equal(r.rows.length, 0);
  assert.ok(
    r.problems.some((p) => p.rowNo === 1 && p.column === "balance" && /text after closing quote/.test(p.message)),
  );
});

test("parseGlFile: comma-only row is not dropped; file returns no rows", () => {
  // Eight empty cells for the eight-column header — not a blank line.
  const r = parseGlFile(`${HEADER}\nUS1,1000,USD,10,,,2026-03-09,\n,,,,,,,\n`);
  assert.equal(r.rows.length, 0);
  assert.ok(r.problems.some((p) => p.rowNo === 2 && p.column === "entity_code"));
});

test("parseGlFile: comma-only then bad quote keep aligned row numbers", () => {
  const r = parseGlFile(`${HEADER}\n,,,,,,,\nUS1,1000,USD,"10"0,,,2026-03-09,\n`);
  assert.equal(r.rows.length, 0);
  assert.ok(r.problems.some((p) => p.rowNo === 1 && p.column === "entity_code"));
  assert.ok(
    r.problems.some((p) => p.rowNo === 2 && p.column === "balance" && /text after closing quote/.test(p.message)),
  );
});

test("parseGlFile: collects quote errors on every bad balance row", () => {
  const r = parseGlFile(
    `${HEADER}\nUS1,1000,USD,"10"0,,,2026-03-09,\nUS1,1000,USD,"20"0,,,2026-03-09,\n`,
  );
  assert.equal(r.rows.length, 0);
  assert.ok(r.problems.some((p) => p.rowNo === 1 && p.column === "balance" && /text after closing quote/.test(p.message)));
  assert.ok(r.problems.some((p) => p.rowNo === 2 && p.column === "balance" && /text after closing quote/.test(p.message)));
});

test("parseGlFile: stray quote does not swallow the next row", () => {
  // Legacy splitCsv would pull row 2 into the quoted balance; the strict pass keeps both rows.
  const r = parseGlFile(`${HEADER}\nUS1,1000,USD,10",,,2026-03-09,\nUS1,2000,USD,NaN,,,2026-03-09,\n`);
  assert.equal(r.rows.length, 0);
  assert.ok(r.problems.some((p) => p.rowNo === 1 && p.column === "balance" && /text around quotes/.test(p.message)));
  assert.ok(r.problems.some((p) => p.rowNo === 2 && p.column === "balance" && /at most 4 places/.test(p.message)));
});

test("parseGlFile: row width must match the header", () => {
  const short = parseGlFile(`${HEADER}\nUS1,1000,USD,10\n`);
  assert.equal(short.rows.length, 0);
  assert.ok(short.problems.some((p) => p.rowNo === 1 && p.column === null && /columns/.test(p.message)));

  const long = parseGlFile(`${HEADER}\nUS1,1000,USD,10,,,2026-03-09,CC-1,EXTRA\n`);
  assert.equal(long.rows.length, 0);
  assert.ok(long.problems.some((p) => p.rowNo === 1 && /columns/.test(p.message)));

  // Named dimension columns in the header are part of the width; empty is fine.
  const dims = parseGlFile(`${HEADER}\nUS1,1000,USD,10,,,2026-03-09,\n`);
  assert.equal(dims.problems.length, 0);
  assert.deepEqual(dims.rows[0]!.dimensions, {});
});

test("parseGlFile: 20,000 rows parse in under 2 seconds", () => {
  const lines = [HEADER];
  for (let i = 0; i < 20_000; i++) {
    lines.push(`E${i % 100},A${i % 500},USD,${(i % 1000) + 0.5},,,2026-03-09,CC-${i % 10}`);
  }
  const text = lines.join("\n") + "\n";
  const start = performance.now();
  const r = parseGlFile(text);
  const ms = performance.now() - start;
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 20_000);
  assert.ok(ms < 2000, `parsed 20k rows in ${ms.toFixed(1)}ms (limit 2000ms)`);
});

const CONTROL_HEADER = "currency,row_count,sum";

test("parseControlFile: valid file, empty currency bucket, and quoted values", () => {
  const plain = parseControlFile(`${CONTROL_HEADER}\nUSD,2,140.50\nEUR,1,5\n`);
  assert.deepEqual(plain.problems, []);
  assert.deepEqual(plain.rows, [
    { currency: "USD", rowCount: 2, sum: "140.50" },
    { currency: "EUR", rowCount: 1, sum: "5" },
  ]);

  const emptyCcy = parseControlFile(`${CONTROL_HEADER}\n,1,0\n`);
  assert.deepEqual(emptyCcy.problems, []);
  assert.deepEqual(emptyCcy.rows, [{ currency: "", rowCount: 1, sum: "0" }]);

  const quoted = parseControlFile(`${CONTROL_HEADER}\nUSD,1,"10.00"\n`);
  assert.deepEqual(quoted.problems, []);
  assert.deepEqual(quoted.rows, [{ currency: "USD", rowCount: 1, sum: "10.00" }]);
});

test("parseControlFile: unclosed quote at EOF is a problem (not a silent decode)", () => {
  // Without a closing quote the decoded cell would look like a valid matching sum.
  const eof = parseControlFile(`${CONTROL_HEADER}\nUSD,1,"10.00`);
  assert.equal(eof.rows.length, 0);
  assert.ok(eof.problems.some((p) => p.rowNo === 1 && p.column === "sum" && /unclosed quote/.test(p.message)));
});

test("parseControlFile: names row and column without echoing cell contents; refuses bad shape", () => {
  const marker = "BAD_SUM_MARKER_9f3a";
  const badSum = parseControlFile(`${CONTROL_HEADER}\nUSD,2,${marker}\n`);
  assert.equal(badSum.rows.length, 0);
  assert.ok(badSum.problems.some((p) => p.rowNo === 1 && p.column === "sum" && /decimal/.test(p.message)));
  assert.ok(badSum.problems.every((p) => !p.message.includes(marker)));

  const unknown = parseControlFile("currency,row_count,sum,extra\nUSD,1,1\n");
  assert.ok(unknown.problems.some((p) => p.column === "extra" && p.rowNo === null));
  const missing = parseControlFile("currency,sum\nUSD,1\n");
  assert.ok(missing.problems.some((p) => p.column === "row_count" && /missing/.test(p.message)));
  const dupCurrency = parseControlFile(`${CONTROL_HEADER}\nUSD,1,1\nUSD,2,2\n`);
  assert.ok(dupCurrency.problems.some((p) => p.rowNo === 2 && p.column === "currency" && /more than once/.test(p.message)));
});
