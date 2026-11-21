// Pure CSV parser for GL balance files (docs/file-layouts.md). Shape only; no database.
import { splitCsv } from "./csv.ts";
import type { GlBalanceRow } from "./rows.ts";

export interface FileProblem {
  readonly rowNo: number | null;
  readonly column: string | null;
  readonly message: string;
}

export interface ParseResult<T> {
  readonly rows: T[];
  readonly problems: FileProblem[];
}

const FIXED = ["entity_code", "account_number", "currency", "balance", "debit", "credit", "as_of"] as const;
const REQUIRED = ["entity_code", "account_number", "currency"] as const;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SIGNED = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const UNSIGNED = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

const normalizeHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

const cell = (raw: string | undefined): string | null => {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
};

const realDate = (v: string): boolean => {
  const m = DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** Fits NUMERIC(24,4): up to 20 digits before the point and 4 after — same bound intake uses. */
function fitsMoney(v: string): boolean {
  const [whole = "", frac = ""] = v.replace(/^[+-]/, "").split(".");
  return whole.replace(/^0+(?=\d)/, "").length <= 20 && frac.replace(/0+$/, "").length <= 4;
}

/**
 * Find malformed quoting before trusting splitCsv's decoded cells.
 * Catches an unclosed quote, and text after a closing quote (e.g. "10"0 → 100).
 * rowNo is null on the header; data rows count from 1. Escaped quotes ("") are fine.
 */
function quotingProblem(
  text: string,
): { rowNo: number | null; columnIndex: number; header: string[] | null; message: string } | null {
  let header: string[] | null = null;
  let row: string[] = [];
  let cellText = "";
  let quoted = false;
  let afterQuote = false;
  let completed = 0;
  const t = text.replace(/^\uFEFF/, "");

  const at = (columnIndex: number, message: string) => ({
    rowNo: (header === null ? null : completed) as number | null,
    columnIndex,
    header,
    message,
  });

  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cellText += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else cellText += c;
    } else if (c === ",") {
      row.push(cellText);
      cellText = "";
      afterQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cellText);
      cellText = "";
      afterQuote = false;
      if (row.some((x) => x.trim() !== "")) {
        if (header === null) header = row;
        completed++;
      }
      row = [];
    } else if (c === '"') {
      if (afterQuote || cellText !== "") return at(row.length, "text around quotes");
      quoted = true;
    } else if (afterQuote) {
      return at(row.length, "text after closing quote");
    } else cellText += c;
  }
  row.push(cellText);
  if (quoted) return at(row.length - 1, "unclosed quote");
  if (afterQuote) {
    // Closing quote at end of field is fine; afterQuote with no following text is OK.
  }
  return null;
}

export function parseGlFile(text: string): ParseResult<GlBalanceRow> {
  const problems: FileProblem[] = [];
  const badQuote = quotingProblem(text);
  if (badQuote) {
    const raw = badQuote.header?.[badQuote.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    return { rows: [], problems: [{ rowNo: badQuote.rowNo, column, message: badQuote.message }] };
  }

  const [header, ...body] = splitCsv(text);
  const index = new Map<string, number>();
  const dimensions: string[] = [];

  if (!header) {
    for (const name of REQUIRED) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
    return { rows: [], problems };
  }

  const fixed = new Set<string>(FIXED);
  const seen = new Map<string, number>();

  header.forEach((raw, i) => {
    const name = normalizeHeader(raw);
    if (name === "") {
      problems.push({ rowNo: null, column: null, message: `empty column header at position ${i + 1}` });
      return;
    }
    if (seen.has(name)) {
      problems.push({ rowNo: null, column: name, message: `duplicate column ${name}` });
      return;
    }
    seen.set(name, i);
    if (fixed.has(name)) index.set(name, i);
    else {
      dimensions.push(name);
      index.set(name, i);
    }
  });

  for (const name of REQUIRED) {
    if (!index.has(name)) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
  }
  // balance / debit / credit / as_of may be absent as columns; treated as empty on every row.

  if (problems.length > 0) return { rows: [], problems };

  const width = header.length;
  const get = (cells: string[], name: string): string | null => {
    const i = index.get(name);
    if (i === undefined) return null;
    return cell(cells[i]);
  };

  const rows: GlBalanceRow[] = [];
  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (cells.length !== width) {
      problems.push({
        rowNo,
        column: null,
        message: `row has ${cells.length} columns; header has ${width}`,
      });
      return;
    }
    const entityCode = get(cells, "entity_code");
    const accountNumber = get(cells, "account_number");
    const currency = get(cells, "currency");
    const balance = get(cells, "balance");
    const debit = get(cells, "debit");
    const credit = get(cells, "credit");
    const asOf = get(cells, "as_of");

    if (entityCode === null) problems.push({ rowNo, column: "entity_code", message: "entity_code is required" });
    if (accountNumber === null) problems.push({ rowNo, column: "account_number", message: "account_number is required" });
    if (currency === null) problems.push({ rowNo, column: "currency", message: "currency is required" });
    else if (!CURRENCY.test(currency)) {
      problems.push({ rowNo, column: "currency", message: "currency must be three upper-case letters" });
    }

    if (asOf !== null && !realDate(asOf)) {
      problems.push({ rowNo, column: "as_of", message: "as_of must be a real date written YYYY-MM-DD" });
    }

    // Match intake: balance XOR (debit or credit); neither and both are refused.
    const hasBalance = balance !== null;
    const hasSide = debit !== null || credit !== null;
    if (hasBalance && hasSide) {
      problems.push({
        rowNo,
        column: "balance",
        message: "send a balance or debit and credit amounts, not both",
      });
    } else if (!hasBalance && !hasSide) {
      problems.push({
        rowNo,
        column: "balance",
        message: "a balance, or a debit or credit amount, is required",
      });
    } else {
      if (balance !== null && (!SIGNED.test(balance) || !fitsMoney(balance))) {
        problems.push({ rowNo, column: "balance", message: "balance must be a number with at most 4 places" });
      }
      if (debit !== null && (!UNSIGNED.test(debit) || !fitsMoney(debit))) {
        problems.push({ rowNo, column: "debit", message: "debit must be a non-negative number with at most 4 places" });
      }
      if (credit !== null && (!UNSIGNED.test(credit) || !fitsMoney(credit))) {
        problems.push({ rowNo, column: "credit", message: "credit must be a non-negative number with at most 4 places" });
      }
    }

    const dims: Record<string, string> = {};
    for (const name of dimensions) {
      const v = get(cells, name);
      if (v !== null) dims[name] = v;
    }

    if (problems.some((p) => p.rowNo === rowNo)) return;
    rows.push({
      entityCode,
      accountNumber,
      currency,
      balance,
      debit,
      credit,
      asOf,
      dimensions: dims,
    });
  });

  return { rows: problems.length > 0 ? [] : rows, problems };
}
