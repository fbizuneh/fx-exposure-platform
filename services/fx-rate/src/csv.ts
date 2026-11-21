// One of four identical CSV readers (master-data, data-source, fx-rate, fx-trade); change all four together.

/** Comma-separated text with quotes. A blank line is skipped; a comma-only record (all cells empty, width > 1) is kept. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/^﻿/, "");
  const keep = (r: string[]) => r.some((x) => x.trim() !== "") || r.length > 1;
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
      if (keep(row)) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (keep(row)) rows.push(row);
  return rows;
}

/** Malformed quoting before trusting splitCsv cells. rowNo is null on the header; data rows count from 1. */
export function quotingProblem(
  text: string,
): { rowNo: number | null; columnIndex: number; header: string[] | null; message: string } | null {
  let header: string[] | null = null;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let completed = 0;
  const t = text.replace(/^﻿/, "");
  const at = (columnIndex: number, message: string) => ({
    rowNo: (header === null ? null : completed) as number | null,
    columnIndex,
    header,
    message,
  });
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else cell += c;
    } else if (c === ",") {
      row.push(cell); cell = ""; afterQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = ""; afterQuote = false;
      if (row.some((x) => x.trim() !== "")) {
        if (header === null) header = row;
        completed++;
      }
      row = [];
    } else if (c === '"') {
      if (afterQuote || cell !== "") return at(row.length, "text around quotes");
      quoted = true;
    } else if (afterQuote) {
      return at(row.length, "text after closing quote");
    } else cell += c;
  }
  row.push(cell);
  if (quoted) return at(row.length - 1, "unclosed quote");
  return null;
}
