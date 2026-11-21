// FX rate file loader: parse, then load through FX Rate's entry point.
import type { AsOfDate, TenantId } from "@shared/kernel";
import { parseRatesFile, RatesInvalid } from "../../../services/fx-rate/src/index.ts";
import type { App } from "../compose.ts";
import type { LoadOutcome } from "./outcome.ts";

export interface RatesLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly source: string;
  readonly businessDate: AsOfDate;
  readonly by: string;
}

export async function loadRatesFile(app: App, opts: RatesLoadOptions): Promise<LoadOutcome> {
  const parsed = parseRatesFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    const result = await app.fxRate.commands.loadRates({
      tenantId: opts.tenantId,
      source: opts.source,
      businessDate: opts.businessDate,
      rows: parsed.rows,
      by: opts.by,
    });
    return {
      kind: "DONE",
      status: result.status,
      counts: {
        accepted: result.accepted,
        flagged: result.flagged,
      },
    };
  } catch (e) {
    if (e instanceof RatesInvalid) return { kind: "REFUSED", message: e.message };
    throw e;
  }
}
