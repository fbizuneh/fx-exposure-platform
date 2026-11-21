// Executed-trade file loader: parse with FX Trade's existing parser, then import.
// parseExecutedFile does not collect shape problems; missing fields are handled by the import command.
import type { TenantId } from "@shared/kernel";
import { parseExecutedFile } from "../../../services/fx-trade/src/index.ts";
import type { App } from "../compose.ts";
import type { LoadOutcome } from "./outcome.ts";

export interface ExecutedLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly by: string;
}

export async function loadExecutedFile(app: App, opts: ExecutedLoadOptions): Promise<LoadOutcome> {
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
