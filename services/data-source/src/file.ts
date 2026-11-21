// Pure CSV parsers for GL balance and control-total files (docs/file-layouts.md / D7). Shape only; no database.
import type { ExpectedTotal } from "./control-totals.ts";
import { readCsvStrict } from "./csv.ts";
import type { GlBalanceRow } from "./rows.ts";
import { SIGNED, UNSIGNED, fits } from "./validate.ts";

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
const CONTROL_COLUMNS = ["currency", "row_count", "sum"] as const;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REAL_INT = /^(0|[1-9]\d*)$/;
const REAL_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

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

export function parseGlFile(text: string): ParseResult<GlBalanceRow> {
  const problems: FileProblem[] = [];
  const strict = readCsvStrict(text);
  for (const badQuote of strict.problems) {
    const raw = badQuote.header?.[badQuote.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    problems.push({ rowNo: badQuote.rowNo, column, message: badQuote.message });
  }

  const [header, ...body] = strict.rows;
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
  // Quote problems do not skip body checks — row numbers must stay aligned with splitCsv.

  if (REQUIRED.some((name) => !index.has(name))) return { rows: [], problems };

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
      if (balance !== null && (!SIGNED.test(balance) || !fits(balance))) {
        problems.push({ rowNo, column: "balance", message: "balance must be a number with at most 4 places" });
      }
      if (debit !== null && (!UNSIGNED.test(debit) || !fits(debit))) {
        problems.push({ rowNo, column: "debit", message: "debit must be a non-negative number with at most 4 places" });
      }
      if (credit !== null && (!UNSIGNED.test(credit) || !fits(credit))) {
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

/**
 * Parses a control-total CSV (`currency`, `row_count`, `sum`) into expectedTotals (D7 / decision 0031).
 * Uses the same strict CSV reader as parseGlFile so an unclosed quote at EOF is a problem, not a silent decode.
 * Problems name row/column only — never cell contents.
 */
export function parseControlFile(text: string): ParseResult<ExpectedTotal> {
  const problems: FileProblem[] = [];
  const strict = readCsvStrict(text);
  for (const badQuote of strict.problems) {
    const raw = badQuote.header?.[badQuote.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    problems.push({ rowNo: badQuote.rowNo, column, message: badQuote.message });
  }

  const [header, ...body] = strict.rows;

  if (!header) {
    for (const name of CONTROL_COLUMNS) {
      problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
    }
    return { rows: [], problems };
  }

  const index = new Map<string, number>();
  const seen = new Map<string, number>();
  const allowed = new Set<string>(CONTROL_COLUMNS);

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
    if (!allowed.has(name)) {
      problems.push({ rowNo: null, column: name, message: `unknown column ${name}` });
      return;
    }
    index.set(name, i);
  });

  for (const name of CONTROL_COLUMNS) {
    if (!index.has(name)) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
  }
  if (CONTROL_COLUMNS.some((name) => !index.has(name))) return { rows: [], problems };

  const width = header.length;
  const get = (cells: string[], name: string): string | null => {
    const i = index.get(name);
    if (i === undefined) return null;
    return cell(cells[i]);
  };

  const rows: ExpectedTotal[] = [];
  const seenCurrency = new Set<string>();

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

    const currencyRaw = get(cells, "currency");
    const rowCountRaw = get(cells, "row_count");
    const sumRaw = get(cells, "sum");

    // Empty currency is the no-currency bucket (""); otherwise three upper-case letters.
    let currency = "";
    if (currencyRaw !== null) {
      if (!CURRENCY.test(currencyRaw)) {
        problems.push({
          rowNo,
          column: "currency",
          message: "currency must be three upper-case letters or empty",
        });
      } else currency = currencyRaw;
    }

    if (rowCountRaw === null) {
      problems.push({ rowNo, column: "row_count", message: "row_count is required" });
    } else if (!REAL_INT.test(rowCountRaw)) {
      problems.push({
        rowNo,
        column: "row_count",
        message: "row_count must be a whole number of 0 or more",
      });
    }

    if (sumRaw === null) {
      problems.push({ rowNo, column: "sum", message: "sum is required" });
    } else if (!REAL_DECIMAL.test(sumRaw)) {
      problems.push({ rowNo, column: "sum", message: "sum must be a decimal amount" });
    }

    const currencyOk = currencyRaw === null || CURRENCY.test(currencyRaw);
    const rowCountOk = rowCountRaw !== null && REAL_INT.test(rowCountRaw);
    const sumOk = sumRaw !== null && REAL_DECIMAL.test(sumRaw);
    if (!currencyOk || !rowCountOk || !sumOk) return;

    if (seenCurrency.has(currency)) {
      problems.push({ rowNo, column: "currency", message: "currency is listed more than once" });
      return;
    }
    seenCurrency.add(currency);
    rows.push({ currency, rowCount: Number(rowCountRaw), sum: sumRaw! });
  });

  return { rows: problems.length > 0 ? [] : rows, problems };
}
