// Executed-trade file loader: reject CSV syntax errors, then parse and import.
// Missing/invalid trade fields stay with the import command (Decision 0009 partial acceptance).
import type { TenantId } from "@shared/kernel";
import { parseExecutedFile, quotingProblems } from "../../../services/fx-trade/src/index.ts";
import type { App } from "../compose.ts";
import type { FileProblem, LoadOutcome } from "./outcome.ts";

export interface ExecutedLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly by: string;
}

const normalizeHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

function csvSyntaxProblems(text: string): FileProblem[] {
  return quotingProblems(text).map((bad) => {
    const raw = bad.header?.[bad.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    return { rowNo: bad.rowNo, column, message: bad.message };
  });
}

export async function loadExecutedFile(app: App, opts: ExecutedLoadOptions): Promise<LoadOutcome> {
  const syntax = csvSyntaxProblems(opts.text);
  if (syntax.length > 0) return { kind: "INVALID_FILE", problems: syntax };

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
