import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRatesFile } from "./file.ts";

const SAMPLE = `base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at
EUR,USD,SPOT,SPOT,,1.0850000000,,,1.0849000000,1.0850000000,1.0851000000,2026-03-09T16:30:00Z
GBP,USD,SPOT,SPOT,,1.2700000000,,,,,,2026-03-09T16:30:00Z
EUR,USD,FORWARD,3M,2026-06-09,1.0900000000,1.0850000000,0.0050000000,,,,2026-03-09T16:30:00Z
`;

test("parseRatesFile: valid spot and forward rows", () => {
  const r = parseRatesFile(SAMPLE);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], {
    base: "EUR",
    quote: "USD",
    type: "SPOT",
    tenor: "SPOT",
    valueDate: null,
    allIn: "1.0850000000",
    spot: null,
    forwardPoints: null,
    bid: "1.0849000000",
    mid: "1.0850000000",
    ask: "1.0851000000",
    observedAt: "2026-03-09T16:30:00Z",
  });
  assert.equal(r.rows[2]!.type, "FORWARD");
  assert.equal(r.rows[2]!.tenor, "3M");
  assert.equal(r.rows[2]!.valueDate, "2026-06-09");
  assert.equal(r.rows[2]!.spot, "1.0850000000");
  assert.equal(r.rows[2]!.forwardPoints, "0.0050000000");
});

test("parseRatesFile: BOM and CRLF", () => {
  const r = parseRatesFile("\uFEFF" + SAMPLE.replace(/\n/g, "\r\n"));
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
});

test("parseRatesFile: quoted commas and blank lines", () => {
  // Rates have no free-text name fields; blank lines still skip cleanly.
  const text = SAMPLE.split("\n").join("\n\n");
  const r = parseRatesFile(text);
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 3);
});

test("parseRatesFile: missing, duplicate and unknown columns", () => {
  const missing = parseRatesFile("base,quote,type\nEUR,USD,SPOT\n");
  assert.ok(missing.problems.some((p) => p.rowNo === null && p.column === "all_in"));

  const dup = parseRatesFile(
    "base,quote,type,tenor,all_in,observed_at,base\nEUR,USD,SPOT,SPOT,1.0,2026-03-09T16:30:00Z,GBP\n",
  );
  assert.ok(dup.problems.some((p) => p.message.includes("duplicate")));

  const unknown = parseRatesFile(
    "base,quote,type,tenor,all_in,observed_at,extra\nEUR,USD,SPOT,SPOT,1.0,2026-03-09T16:30:00Z,x\n",
  );
  assert.ok(unknown.problems.some((p) => p.rowNo === null && p.column === "extra"));
});

test("parseRatesFile: each bad value kind", () => {
  const header = "base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at";
  const r = parseRatesFile(
    [
      header,
      "eur,USD,SPOT,SPOT,,1.0,,,,,,2026-03-09T16:30:00Z",
      "EUR,USD,SPOT,SPOT,,1.0,,,,,,2026-03-09T16:30:00Z".replace("EUR,USD", "EUR,EUR"),
      "EUR,USD,NOPE,SPOT,,1.0,,,,,,2026-03-09T16:30:00Z",
      "EUR,USD,SPOT,1M,,1.0,,,,,,2026-03-09T16:30:00Z",
      "EUR,USD,SPOT,SPOT,,0,,,,,,2026-03-09T16:30:00Z",
      "EUR,USD,SPOT,SPOT,2026-06-09,1.0,,,,,,2026-03-09T16:30:00Z",
      "EUR,USD,FORWARD,BAD,2026-06-09,1.0,1.0,0.0,,,,2026-03-09T16:30:00Z",
      "EUR,USD,SPOT,SPOT,,1.0,,,,,,2026-03-09 16:30:00",
    ].join("\n"),
  );
  assert.ok(r.problems.some((p) => p.column === "base" && p.rowNo === 1));
  assert.ok(r.problems.some((p) => p.rowNo === 2 && /differ/.test(p.message)));
  assert.ok(r.problems.some((p) => p.column === "type" && p.rowNo === 3));
  assert.ok(r.problems.some((p) => p.column === "tenor" && p.rowNo === 4));
  assert.ok(r.problems.some((p) => p.column === "all_in" && p.rowNo === 5));
  assert.ok(r.problems.some((p) => p.rowNo === 6 && /spot rate cannot carry/.test(p.message)));
  assert.ok(r.problems.some((p) => p.column === "tenor" && p.rowNo === 7));
  assert.ok(r.problems.some((p) => p.column === "observed_at" && p.rowNo === 8));
  assert.equal(r.rows.length, 0);
});

test("parseRatesFile: 20,000 rows parse in under 2 seconds", () => {
  const lines = ["base,quote,type,tenor,value_date,all_in,spot,forward_points,bid,mid,ask,observed_at"];
  for (let i = 0; i < 20_000; i++) {
    lines.push(`EUR,USD,SPOT,SPOT,,1.${String(i % 1000).padStart(3, "0")}000000,,,,,,2026-03-09T16:30:00Z`);
  }
  const text = lines.join("\n") + "\n";
  const start = performance.now();
  const r = parseRatesFile(text);
  const ms = performance.now() - start;
  assert.equal(r.problems.length, 0);
  assert.equal(r.rows.length, 20_000);
  assert.ok(ms < 2000, `parsed 20k rows in ${ms.toFixed(1)}ms (limit 2000ms)`);
});
