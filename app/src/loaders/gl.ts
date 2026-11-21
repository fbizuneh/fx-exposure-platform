// GL balance file loader: parse, then submit through Data Source's entry point.
import type { AsOfDate, TenantId } from "@shared/kernel";
import {
  BatchRefused,
  parseGlFile,
  type ExpectedTotal,
} from "../../../services/data-source/src/index.ts";
import type { App } from "../compose.ts";
import type { LoadOutcome } from "./outcome.ts";

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
