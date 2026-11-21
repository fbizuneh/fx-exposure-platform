// GL balance file loader: parse, then submit through Data Source's entry point.
import type { AsOfDate, TenantId } from "@shared/kernel";
import {
  BatchRefused,
  parseGlFile,
  type ExpectedTotal,
} from "../../../services/data-source/src/index.ts";
import type { App } from "../compose.ts";
import type { FileProblem, LoadOutcome } from "./outcome.ts";

export interface GlLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly chartCode: string;
  readonly asOf: AsOfDate;
  readonly sourceSystem: string;
  readonly by: string;
  /** When set, passed through as GlBatch.expectedTotals (decision 0031 / D7). */
  readonly expectedTotals?: readonly ExpectedTotal[];
}

export interface ControlParseResult {
  readonly rows: ExpectedTotal[];
  readonly problems: FileProblem[];
}

const CONTROL_COLUMNS = ["currency", "row_count", "sum"] as const;
const REAL_INT = /^(0|[1-9]\d*)$/;
const REAL_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const CURRENCY = /^[A-Z]{3}$/;

const normalizeHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

const cell = (raw: string | undefined): string | null => {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
};

/** Minimal CSV split for the small control-total file (BOM, CRLF/LF, quotes, blank lines). */
function splitControlCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "") || row.length > 1) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "") || row.length > 1) rows.push(row);
  return rows;
}

/**
 * Parses a control-total CSV (`currency`, `row_count`, `sum`) into expectedTotals.
 * Problems name row/column only — never cell contents.
 */
export function parseControlFile(text: string): ControlParseResult {
  const problems: FileProblem[] = [];
  const rawRows = splitControlCsv(text);
  const [header, ...body] = rawRows;

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

  if (problems.length > 0) return { rows: [], problems };
  return { rows, problems };
}

export async function loadGlFile(app: App, opts: GlLoadOptions): Promise<LoadOutcome> {
  const parsed = parseGlFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };

  // D1: a supplied row as_of must equal the batch as-of; blank stays allowed. Mismatches must not
  // reach Data Source (which would only block those rows and could store the rest).
  const asOfMismatches = parsed.rows.flatMap((row, i) => {
    if (row.asOf === null || row.asOf === opts.asOf) return [];
    return [{
      rowNo: i + 1,
      column: "as_of",
      message: "as_of differs from the batch as-of",
    }];
  });
  if (asOfMismatches.length > 0) return { kind: "INVALID_FILE", problems: asOfMismatches };

  try {
    const result = await app.dataSource.commands.submitGlBatch({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      chartCode: opts.chartCode,
      asOf: opts.asOf,
      rows: parsed.rows,
      by: opts.by,
      ...(opts.expectedTotals !== undefined ? { expectedTotals: opts.expectedTotals } : {}),
    });
    return {
      kind: "DONE",
      status: result.status,
      counts: {
        received: result.received,
        included: result.included,
        excluded: result.excluded,
        blocked: result.blocked,
      },
    };
  } catch (e) {
    if (e instanceof BatchRefused) return { kind: "REFUSED", message: e.message };
    throw e;
  }
}
