// One of four identical CSV readers (master-data, data-source, fx-rate, fx-trade); change all four together.

/** Comma-separated text with quotes. A blank line is skipped; a comma-only record (all cells empty, width > 1) is kept. */
const keepCsvRow = (r: readonly string[]) => r.some((x) => x.trim() !== "") || r.length > 1;

export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (keepCsvRow(row)) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (keepCsvRow(row)) rows.push(row);
  return rows;
}

export interface QuotingIssue {
  readonly rowNo: number | null;
  readonly columnIndex: number;
  readonly header: string[] | null;
  readonly message: string;
}

/**
 * Strict CSV pass for D3 parsers: rows and quote diagnostics share the same record
 * boundaries. A stray quote (e.g. 10") does not swallow the next line; valid quoted
 * fields, escaped quotes, and multiline quoted fields still work. Legacy splitCsv
 * stays permissive for FX Trade.
 */
export function readCsvStrict(text: string): { rows: string[][]; problems: QuotingIssue[] } {
  const rows: string[][] = [];
  const problems: QuotingIssue[] = [];
  let header: string[] | null = null;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let brokenField = false;
  let completed = 0;
  const t = text.replace(/^﻿/, "");
  const at = (columnIndex: number, message: string): QuotingIssue => ({
    rowNo: header === null ? null : completed,
    columnIndex,
    header,
    message,
  });
  const endField = () => {
    row.push(cell);
    cell = "";
    afterQuote = false;
    brokenField = false;
  };
  const endRow = () => {
    endField();
    if (keepCsvRow(row)) {
      if (header === null) header = row;
      rows.push(row);
      completed++;
    }
    row = [];
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else cell += c;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      endRow();
    } else if (brokenField) {
      cell += c;
    } else if (c === '"') {
      if (afterQuote || cell !== "") {
        problems.push(at(row.length, afterQuote ? "text after closing quote" : "text around quotes"));
        brokenField = true;
        afterQuote = false;
        cell += c;
      } else {
        quoted = true;
      }
    } else if (afterQuote) {
      problems.push(at(row.length, "text after closing quote"));
      brokenField = true;
      afterQuote = false;
      cell += c;
    } else cell += c;
  }
  if (quoted) {
    // Unclosed at EOF: do not invent later record boundaries; emit the partial row once.
    problems.push(at(row.length, "unclosed quote"));
    endField();
    if (keepCsvRow(row)) {
      if (header === null) header = row;
      rows.push(row);
    }
  } else {
    endRow();
  }
  return { rows, problems };
}

/** Quote diagnostics from the strict pass (same boundaries as readCsvStrict rows). */
export function quotingProblems(text: string): QuotingIssue[] {
  return readCsvStrict(text).problems;
}
