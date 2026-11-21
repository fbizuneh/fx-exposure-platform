// Every ```csv example in docs/file-layouts.md must have the same cell count on every row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC = path.join(ROOT, "docs/file-layouts.md");

/** Same rules as FX Trade's splitCsv: commas, quotes, LF/CRLF, blank lines skipped. */
function splitCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

function csvBlocks(markdown) {
  return [...markdown.matchAll(/```csv\n([\s\S]*?)```/g)].map((m, i) => ({
    index: i + 1,
    text: m[1],
  }));
}

test("file-layouts.md examples: every data row has the header's cell count", () => {
  const md = fs.readFileSync(DOC, "utf8");
  const blocks = csvBlocks(md);
  assert.equal(blocks.length, 9, "expected one csv example per kind");

  const problems = [];
  for (const block of blocks) {
    const rows = splitCsv(block.text);
    assert.ok(rows.length >= 2, `csv block ${block.index}: need a header and at least one data row`);
    const width = rows[0].length;
    for (let r = 1; r < rows.length; r++) {
      if (rows[r].length !== width) {
        problems.push(
          `csv block ${block.index} data row ${r}: ${rows[r].length} cells, header has ${width}`,
        );
      }
    }
  }
  assert.deepEqual(problems, []);
});
