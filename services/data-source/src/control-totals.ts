// Compares what a batch's rows add up to, per currency, against what the sender expected (decision #J1).
// A row with no currency is grouped under "" everywhere this file and its callers use a currency key.
import { Decimal } from "decimal.js";

export interface ExpectedTotal {
  readonly currency: string;
  readonly rowCount: number;
  readonly sum: string;
}

export interface ReceivedTotal {
  readonly rows: number;
  readonly sum: string;
}

/** One line per currency that differs, naming both numbers. Empty when every currency matches on both sides. */
export function diffTotals(received: ReadonlyMap<string, ReceivedTotal>, expected: readonly ExpectedTotal[]): string[] {
  const expectedByCurrency = new Map(expected.map((e) => [e.currency, e]));
  const currencies = new Set<string>([...received.keys(), ...expectedByCurrency.keys()]);
  const diffs: string[] = [];
  for (const currency of [...currencies].sort()) {
    const r = received.get(currency) ?? { rows: 0, sum: "0.0000" };
    const e = expectedByCurrency.get(currency);
    const label = currency === "" ? "(no currency)" : currency;
    if (!e) {
      diffs.push(`${label}: received ${r.rows} rows / ${r.sum}, not expected`);
      continue;
    }
    let sameSum: boolean;
    try {
      sameSum = new Decimal(r.sum).equals(new Decimal(e.sum));
    } catch {
      sameSum = false;
    }
    if (r.rows !== e.rowCount || !sameSum) diffs.push(`${label}: received ${r.rows} rows / ${r.sum}, expected ${e.rowCount} rows / ${e.sum}`);
  }
  return diffs;
}
