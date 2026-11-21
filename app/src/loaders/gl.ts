// GL balance file loader: parse, then submit through Data Source's entry point.
import type { AsOfDate, TenantId } from "@shared/kernel";
import { BatchRefused, parseGlFile } from "../../../services/data-source/src/index.ts";
import type { App } from "../compose.ts";
import type { LoadOutcome } from "./outcome.ts";

export interface GlLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly chartCode: string;
  readonly asOf: AsOfDate;
  readonly sourceSystem: string;
  readonly by: string;
}

export async function loadGlFile(app: App, opts: GlLoadOptions): Promise<LoadOutcome> {
  const parsed = parseGlFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    const result = await app.dataSource.commands.submitGlBatch({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      chartCode: opts.chartCode,
      asOf: opts.asOf,
      rows: parsed.rows,
      by: opts.by,
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
