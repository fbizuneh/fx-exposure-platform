import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGlFile } from "./file.ts";

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
