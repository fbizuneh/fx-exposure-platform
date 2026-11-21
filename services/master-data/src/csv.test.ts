import { test } from "node:test";
import assert from "node:assert/strict";
import { quotingProblems, readCsvStrict, splitCsv } from "./csv.ts";

test("splitCsv: quoted commas, escaped quotes, blank lines, CRLF and trailing newline", () => {
  assert.deepEqual(splitCsv('a,"b,1",c\r\n\r\n"x ""q""",,z\n'), [["a", "b,1", "c"], ['x "q"', "", "z"]]);
});

test("splitCsv: LF line endings without a trailing newline", () => {
  assert.deepEqual(splitCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("splitCsv: CRLF line endings", () => {
  assert.deepEqual(splitCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
});

test("splitCsv: strips a leading byte-order mark", () => {
  assert.deepEqual(splitCsv("\uFEFFa,b\nc,d\n"), [["a", "b"], ["c", "d"]]);
});

test("splitCsv: blank lines are skipped", () => {
  assert.deepEqual(splitCsv("a,b\n\n\nc,d\n"), [["a", "b"], ["c", "d"]]);
});

test("splitCsv: comma-only records are kept; blank lines are not", () => {
  assert.deepEqual(splitCsv("a,b\n,\n1,2\n"), [["a", "b"], ["", ""], ["1", "2"]]);
  assert.deepEqual(splitCsv("a,b,c\n,,\n"), [["a", "b", "c"], ["", "", ""]]);
  assert.deepEqual(splitCsv("a,b\n\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("quotingProblems: unclosed quote, text after close; valid and escaped quotes ok", () => {
  assert.equal(quotingProblems('a,b\n1,"2\n')[0]?.message, "unclosed quote");
  assert.equal(quotingProblems('a,b\n1,"2"0\n')[0]?.message, "text after closing quote");
  assert.deepEqual(quotingProblems('a,b\n1,"2""3",4\n'), []);
  assert.deepEqual(quotingProblems('a,b\n1,"2,3",4\n'), []);
  assert.deepEqual(quotingProblems('a,b\n1,"line\nstill",2\n'), []);
});

test("quotingProblems: comma-only rows share splitCsv numbering", () => {
  const bad = quotingProblems('a,b\n,\n1,"2"0\n');
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.rowNo, 2);
  assert.equal(bad[0]?.columnIndex, 1);
  assert.equal(bad[0]?.message, "text after closing quote");
});

test("quotingProblems: collects every recoverable quote error", () => {
  const bad = quotingProblems('a,b\n1,"2"0\n3,"4"5\n');
  assert.equal(bad.length, 2);
  assert.deepEqual(
    bad.map((p) => [p.rowNo, p.columnIndex, p.message]),
    [
      [1, 1, "text after closing quote"],
      [2, 1, "text after closing quote"],
    ],
  );
});

test("readCsvStrict: stray quote keeps the next record; legacy splitCsv swallows it", () => {
  const text = "a,b\n1,10\"\n2,NaN\n";
  assert.equal(splitCsv(text).length, 2, "legacy merges the second data row into the open quote");
  const strict = readCsvStrict(text);
  assert.equal(strict.rows.length, 3);
  assert.deepEqual(strict.rows[2], ["2", "NaN"]);
  assert.equal(strict.problems[0]?.rowNo, 1);
  assert.equal(strict.problems[0]?.message, "text around quotes");
});
