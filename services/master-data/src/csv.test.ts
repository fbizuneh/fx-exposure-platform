import { test } from "node:test";
import assert from "node:assert/strict";
import { quotingProblem, splitCsv } from "./csv.ts";

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

test("quotingProblem: unclosed quote, text after close; valid and escaped quotes ok", () => {
  assert.equal(quotingProblem('a,b\n1,"2\n')?.message, "unclosed quote");
  assert.equal(quotingProblem('a,b\n1,"2"0\n')?.message, "text after closing quote");
  assert.equal(quotingProblem('a,b\n1,"2""3",4\n'), null);
  assert.equal(quotingProblem('a,b\n1,"2,3",4\n'), null);
});

test("quotingProblem: comma-only rows share splitCsv numbering", () => {
  const bad = quotingProblem('a,b\n,\n1,"2"0\n');
  assert.equal(bad?.rowNo, 2);
  assert.equal(bad?.columnIndex, 1);
  assert.equal(bad?.message, "text after closing quote");
});
