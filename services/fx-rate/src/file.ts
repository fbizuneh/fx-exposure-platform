// Pure CSV parser for FX rate files (docs/file-layouts.md). Shape only; no database.
import { splitCsv } from "./csv.ts";
import type { RateRow } from "./rows.ts";

export interface FileProblem {
  readonly rowNo: number | null;
  readonly column: string | null;
  readonly message: string;
}

export interface ParseResult<T> {
  readonly rows: T[];
  readonly problems: FileProblem[];
}

const REQUIRED = ["base", "quote", "type", "tenor", "all_in", "observed_at"] as const;
const OPTIONAL = ["value_date", "spot", "forward_points", "bid", "mid", "ask"] as const;

const CURRENCY = /^[A-Z]{3}$/;
const TENOR = /^[1-9][0-9]{0,2}[DWMY]$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const SIGNED = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

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

/** Calendar date and clock must be real; Date.parse alone would accept 2026-02-30 as March 2. */
function realTimestamp(v: string): boolean {
  const m = TIMESTAMP.exec(v);
  if (!m || !realDate(m[1]!)) return false;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  const second = Number(m[4]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Find an unclosed quote before trusting splitCsv's decoded cells.
 * rowNo is null on the header; data rows count from 1. Escaped quotes ("") are fine.
 */
function unclosedQuote(text: string): { rowNo: number | null; columnIndex: number; header: string[] | null } | null {
  let header: string[] | null = null;
  let row: string[] = [];
  let cellText = "";
  let quoted = false;
  let completed = 0;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cellText += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cellText += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cellText);
      cellText = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cellText);
      cellText = "";
      if (row.some((x) => x.trim() !== "")) {
        if (header === null) header = row;
        completed++;
      }
      row = [];
    } else cellText += c;
  }
  row.push(cellText);
  if (!quoted) return null;
  return { rowNo: header === null ? null : completed, columnIndex: row.length - 1, header };
}

/** Fits NUMERIC(20,10): at most 10 places and 10 digits before the point. */
function fitsRate(v: string): boolean {
  const [whole = "", frac = ""] = v.replace(/^[+-]/, "").split(".");
  return whole.replace(/^0+(?=\d)/, "").length <= 10 && frac.length <= 10;
}

function mapColumns(header: string[] | undefined): { index: Map<string, number>; problems: FileProblem[] } {
  const problems: FileProblem[] = [];
  const index = new Map<string, number>();
  if (!header) {
    for (const name of REQUIRED) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
    return { index, problems };
  }
  const known = new Set<string>([...REQUIRED, ...OPTIONAL]);
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
    if (!known.has(name)) {
      problems.push({ rowNo: null, column: name, message: `unknown column ${name}` });
      return;
    }
    index.set(name, i);
  });
  for (const name of REQUIRED) {
    if (!index.has(name)) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
  }
  return { index, problems };
}

function parsePositive(
  problems: FileProblem[],
  rowNo: number,
  column: string,
  value: string | null,
  required: boolean,
): string | null {
  if (value === null) {
    if (required) problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  if (!POSITIVE.test(value) || !fitsRate(value) || Number(value) <= 0) {
    problems.push({ rowNo, column, message: `${column} must be a positive number with at most 10 places` });
    return null;
  }
  return value;
}

export function parseRatesFile(text: string): ParseResult<RateRow> {
  const badQuote = unclosedQuote(text);
  if (badQuote) {
    const raw = badQuote.header?.[badQuote.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    return { rows: [], problems: [{ rowNo: badQuote.rowNo, column, message: "unclosed quote" }] };
  }

  const [header, ...body] = splitCsv(text);
  const { index, problems } = mapColumns(header);
  const rows: RateRow[] = [];
  if (problems.length > 0) return { rows, problems };
  const width = header!.length;

  const get = (cells: string[], name: string): string | null => {
    const i = index.get(name);
    if (i === undefined) return null;
    return cell(cells[i]);
  };

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
    const base = get(cells, "base");
    const quote = get(cells, "quote");
    const typeRaw = get(cells, "type");
    const tenor = get(cells, "tenor");
    const valueDate = get(cells, "value_date");
    const allIn = get(cells, "all_in");
    const spot = get(cells, "spot");
    const forwardPoints = get(cells, "forward_points");
    const bid = get(cells, "bid");
    const mid = get(cells, "mid");
    const ask = get(cells, "ask");
    const observedAt = get(cells, "observed_at");

    let baseOk: string | null = null;
    let quoteOk: string | null = null;
    if (base === null) problems.push({ rowNo, column: "base", message: "base is required" });
    else if (!CURRENCY.test(base)) problems.push({ rowNo, column: "base", message: "base must be three upper-case letters" });
    else baseOk = base;

    if (quote === null) problems.push({ rowNo, column: "quote", message: "quote is required" });
    else if (!CURRENCY.test(quote)) problems.push({ rowNo, column: "quote", message: "quote must be three upper-case letters" });
    else quoteOk = quote;

    if (baseOk !== null && quoteOk !== null && baseOk === quoteOk) {
      problems.push({ rowNo, column: "quote", message: "base and quote must differ" });
    }

    let type: "SPOT" | "FORWARD" | null = null;
    if (typeRaw === null) problems.push({ rowNo, column: "type", message: "type is required" });
    else if (typeRaw !== "SPOT" && typeRaw !== "FORWARD") {
      problems.push({ rowNo, column: "type", message: "type must be SPOT or FORWARD" });
    } else type = typeRaw;

    let tenorOk: string | null = null;
    if (tenor === null) problems.push({ rowNo, column: "tenor", message: "tenor is required" });
    else if (type === "SPOT") {
      if (tenor !== "SPOT") problems.push({ rowNo, column: "tenor", message: "a spot rate has tenor SPOT" });
      else tenorOk = tenor;
    } else if (type === "FORWARD") {
      if (!TENOR.test(tenor)) {
        problems.push({ rowNo, column: "tenor", message: "a forward needs a tenor code such as 1W, 1M or 3M" });
      } else tenorOk = tenor;
    }

    let valueDateOk: string | null = null;
    if (valueDate !== null) {
      if (!realDate(valueDate)) {
        problems.push({ rowNo, column: "value_date", message: "value_date must be a real date written YYYY-MM-DD" });
      } else valueDateOk = valueDate;
    }

    const allInOk = parsePositive(problems, rowNo, "all_in", allIn, true);
    const spotOk = parsePositive(problems, rowNo, "spot", spot, false);
    const bidOk = parsePositive(problems, rowNo, "bid", bid, false);
    const midOk = parsePositive(problems, rowNo, "mid", mid, false);
    const askOk = parsePositive(problems, rowNo, "ask", ask, false);

    let forwardPointsOk: string | null = null;
    if (forwardPoints !== null) {
      if (!SIGNED.test(forwardPoints) || !fitsRate(forwardPoints)) {
        problems.push({
          rowNo,
          column: "forward_points",
          message: "forward_points must be a number with at most 10 places",
        });
      } else forwardPointsOk = forwardPoints;
    }

    let observedAtOk: string | null = null;
    if (observedAt === null) problems.push({ rowNo, column: "observed_at", message: "observed_at is required" });
    else if (!realTimestamp(observedAt)) {
      problems.push({ rowNo, column: "observed_at", message: "observed_at must be an ISO 8601 timestamp with Z" });
    } else observedAtOk = observedAt;

    if (type === "SPOT" && (valueDate !== null || spot !== null || forwardPoints !== null)) {
      problems.push({
        rowNo,
        column: "type",
        message: "a spot rate cannot carry a value date, spot or forward points",
      });
    }

    if (problems.some((p) => p.rowNo === rowNo)) return;
    if (baseOk === null || quoteOk === null || type === null || tenorOk === null || allInOk === null || observedAtOk === null) return;

    rows.push({
      base: baseOk,
      quote: quoteOk,
      type,
      tenor: tenorOk,
      valueDate: valueDateOk,
      allIn: allInOk,
      spot: spotOk,
      forwardPoints: forwardPointsOk,
      bid: bidOk,
      mid: midOk,
      ask: askOk,
      observedAt: observedAtOk,
    });
  });

  return { rows: problems.length > 0 ? [] : rows, problems };
}
