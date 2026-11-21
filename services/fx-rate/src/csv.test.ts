import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCsv } from "./csv.ts";

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
