// Compares what a batch's rows add up to, per currency, against what the sender expected (decision #J1/0031).
// A row with no currency is grouped under "" everywhere this file and its callers use a currency key.
import { Decimal } from "decimal.js";

/** 20,000 rows of up to 20 integer digits each could sum past decimal.js's default 20-significant-digit precision; the other services' calc.ts files hit the same ceiling and clone for the same reason. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface ExpectedTotal {
  readonly currency: string;
  readonly rowCount: number;
  readonly sum: string;
}

export interface ReceivedTotal {
  readonly rows: number;
  readonly sum: string;
}

const REAL_INT = /^(0|[1-9]\d*)$/;
const REAL_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Problems with the shape of `expectedTotals` itself, found before any comparison with what was received. */
export function expectedTotalsProblems(expected: readonly ExpectedTotal[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of expected) {
    const label = e.currency === "" ? "(no currency)" : e.currency;
    if (seen.has(e.currency)) problems.push(`${label} is listed more than once`);
    seen.add(e.currency);
    if (!REAL_INT.test(String(e.rowCount))) problems.push(`${label}: rowCount must be a whole number of 0 or more, not ${JSON.stringify(e.rowCount)}`);
    if (typeof e.sum !== "string" || !REAL_DECIMAL.test(e.sum)) problems.push(`${label}: sum must be a decimal amount, not ${JSON.stringify(e.sum)}`);
  }
  return problems;
}

/**
 * One line per currency that differs, naming both numbers. A currency is "missing" when it is a key on only one
 * side — an explicit `{ rowCount: 0, sum: "0" }` for a currency that was never received still counts as a
 * difference, since it asserts something about a currency the batch carries no evidence of either way.
 * Empty when every currency matches on both sides (the empty `expectedTotals: []` means "no currencies expected
 * at all", so it refuses any batch that received rows under any currency, including the no-currency bucket `""`).
 */
export function diffTotals(received: ReadonlyMap<string, ReceivedTotal>, expected: readonly ExpectedTotal[]): string[] {
  const expectedByCurrency = new Map(expected.map((e) => [e.currency, e]));
  const currencies = new Set<string>([...received.keys(), ...expectedByCurrency.keys()]);
  const diffs: string[] = [];
  for (const currency of [...currencies].sort()) {
    const r = received.get(currency);
    const e = expectedByCurrency.get(currency);
    const label = currency === "" ? "(no currency)" : currency;
    if (r === undefined) {
      diffs.push(`${label}: expected ${e!.rowCount} rows / ${e!.sum}, not received`);
      continue;
    }
    if (e === undefined) {
      diffs.push(`${label}: received ${r.rows} rows / ${r.sum}, not expected`);
      continue;
    }
    let sameSum: boolean;
    try {
      sameSum = new D(r.sum).equals(new D(e.sum));
    } catch {
      sameSum = false;
    }
    if (r.rows !== e.rowCount || !sameSum) diffs.push(`${label}: received ${r.rows} rows / ${r.sum}, expected ${e.rowCount} rows / ${e.sum}`);
  }
  return diffs;
}
