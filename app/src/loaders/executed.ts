// Executed-trade file loader: reject CSV syntax and missing required headers, then parse and import.
// Missing/invalid trade *values* stay with the import command (Decision 0009 partial acceptance).
import type { TenantId } from "@shared/kernel";
import { parseExecutedFile, quotingProblems, splitCsv } from "../../../services/fx-trade/src/index.ts";
import type { App } from "../compose.ts";
import type { FileProblem, LoadOutcome } from "./outcome.ts";

export interface ExecutedLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly by: string;
}

/** Required columns per docs/file-layouts.md (executed trades). */
const REQUIRED_COLUMNS = [
  "trade_id",
  "execution_platform_id",
  "trading_entity",
  "trade_date",
  "value_date",
  "deal_currency",
  "deal_amount",
  "settlement_currency",
  "settlement_amount",
  "instrument",
  "buy_sell",
] as const;

const normalizeHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

function csvSyntaxProblems(text: string): FileProblem[] {
  return quotingProblems(text).map((bad) => {
    const raw = bad.header?.[bad.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    return { rowNo: bad.rowNo, column, message: bad.message };
  });
}

/** Missing required columns and duplicate normalized headers (same rules as parseExecutedFile). */
function headerProblems(text: string): FileProblem[] {
  const [header] = splitCsv(text);
  if (!header) {
    return REQUIRED_COLUMNS.map((column) => ({
      rowNo: null,
      column,
      message: `missing required column ${column}`,
    }));
  }
  const problems: FileProblem[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const raw of header) {
    const name = normalizeHeader(raw);
    if (name === "") continue;
    if (seen.has(name)) {
      problems.push({ rowNo: null, column: name, message: `duplicate column ${name}` });
      continue;
    }
    seen.add(name);
    names.add(name);
  }
  for (const column of REQUIRED_COLUMNS) {
    if (!names.has(column)) {
      problems.push({ rowNo: null, column, message: `missing required column ${column}` });
    }
  }
  return problems;
}

export async function loadExecutedFile(app: App, opts: ExecutedLoadOptions): Promise<LoadOutcome> {
  const syntax = csvSyntaxProblems(opts.text);
  if (syntax.length > 0) return { kind: "INVALID_FILE", problems: syntax };

  const headers = headerProblems(opts.text);
  if (headers.length > 0) return { kind: "INVALID_FILE", problems: headers };

  const rows = parseExecutedFile(opts.text);
  const result = await app.fxTrade.commands.importExecutedTrades({
    tenantId: opts.tenantId,
    rows,
    by: opts.by,
  });
  return {
    kind: "DONE",
    status: result.status,
    counts: {
      received: result.received,
      stored: result.stored,
      unchanged: result.unchanged,
      blocked: result.blocked,
      matched: result.matched,
      unmatched: result.unmatched,
    },
  };
}
