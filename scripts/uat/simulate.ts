// Fictional execution platform for UAT. No service writes: files in, file out.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Decimal } from "decimal.js";
import { OUT_HEADER, splitCsv } from "../../services/fx-trade/src/file.ts";

const EXECUTED_HEADER = ["trade_id", "execution_platform_id", "trading_entity", "counterparty", "trade_date", "value_date", "deal_currency", "deal_amount", "settlement_currency", "settlement_amount", "fixing_date", "instrument", "buy_sell", "portfolio", "hedging_program_id", "pre_trade_reference", "leg"] as const;
const BANKS = ["North Quay Demo Bank", "Blue Mesa Demo Bank", "Copper Vale Demo Bank", "Silver Orchard Demo Bank", "Pine Harbor Demo Bank"] as const;
type Row = Record<string, string>;

function table(text: string, required: readonly string[]): Row[] {
  const [header, ...body] = splitCsv(text);
  if (!header) throw new Error("CSV has no header");
  const names = header.map((h) => h.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("CSV has duplicate columns");
  for (const key of required) if (!names.includes(key)) throw new Error(`CSV is missing ${key}`);
  return body.map((cells, i) => {
    if (cells.length !== names.length) throw new Error(`row ${i + 1} has ${cells.length} cells; expected ${names.length}`);
    return Object.fromEntries(names.map((name, j) => [name, cells[j]!.trim()]));
  });
}
function csvCell(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function share(value: number | undefined, flag: string): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${flag} must be a share from 0 to 1`);
  return value;
}
function date(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("trade date must be YYYY-MM-DD");
}
function ordered<T>(items: readonly T[], seed: string, key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ah = createHash("sha256").update(`${seed}:${key(a)}`).digest("hex");
    const bh = createHash("sha256").update(`${seed}:${key(b)}`).digest("hex");
    return ah.localeCompare(bh) || key(a).localeCompare(key(b));
  });
}

export interface SimulationInput {
  readonly pretrades: string;
  readonly rates: string;
  readonly tradeDate: string;
  readonly seed: string;
  readonly portfolioByProgram: Readonly<Record<string, string>>;
  readonly partial?: number;
  readonly reject?: number;
}

/** Reject a share of whole pre-trades, then execute a share of what remains. A swap is one pre-trade. */
export function simulate(input: SimulationInput): string {
  date(input.tradeDate);
  const reject = share(input.reject, "--reject") ?? 0;
  const partial = share(input.partial, "--partial") ?? 1;
  const trades = table(input.pretrades, OUT_HEADER);
  const rates = table(input.rates, ["base", "quote", "type", "value_date", "all_in"]);
  const groups = new Map<string, Row[]>();
  for (const [i, row] of trades.entries()) {
    const ref = row.pre_trade_reference!;
    if (!ref || !row.hedging_program_id || !row.trading_entity || !row.instrument || !row.deal_currency || !row.settlement_currency || !row.deal_amount || !row.value_date) throw new Error(`pre-trade row ${i + 1} is missing a required value`);
    const members = groups.get(ref) ?? [];
    members.push(row);
    groups.set(ref, members);
  }
  for (const [ref, rows] of groups) {
    const swap = rows[0]!.instrument === "SWAP";
    if (swap ? rows.length !== 2 || rows.map((r) => r.leg).sort().join(",") !== "FAR,NEAR" : rows.length !== 1 || rows[0]!.leg !== "") throw new Error(`pre-trade ${ref} has invalid legs`);
    if (rows.some((r) => r.hedging_program_id !== rows[0]!.hedging_program_id || r.instrument !== rows[0]!.instrument || r.trading_entity !== rows[0]!.trading_entity)) throw new Error(`pre-trade ${ref} has inconsistent legs`);
  }
  const randomized = ordered([...groups], input.seed, ([ref]) => ref);
  const kept = randomized.slice(Math.floor(reject * randomized.length));
  const chosen = new Set(kept.slice(0, Math.floor(partial * kept.length)).map(([ref]) => ref));
  const byRate = new Map<string, string>();
  const forwardCurves = new Map<string, { valueDate: string; rate: Decimal }[]>();
  for (const [i, rate] of rates.entries()) {
    const amount = rate.all_in!;
    if (!/^(?:\d+)(?:\.\d+)?$/.test(amount) || !new Decimal(amount).isPositive()) throw new Error(`rate row ${i + 1} has invalid all_in`);
    const key = `${rate.base}|${rate.quote}|${rate.type}|${rate.value_date}`;
    if (byRate.has(key)) throw new Error(`duplicate rate ${key}`);
    byRate.set(key, amount);
    if (rate.type === "FORWARD") {
      const valueDate = rate.value_date!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate) || Number.isNaN(Date.parse(`${valueDate}T00:00:00Z`)) || new Date(`${valueDate}T00:00:00Z`).toISOString().slice(0, 10) !== valueDate) throw new Error(`rate row ${i + 1} has invalid forward value_date`);
      const pair = `${rate.base}|${rate.quote}`;
      const curve = forwardCurves.get(pair) ?? [];
      curve.push({ valueDate, rate: new Decimal(amount) });
      forwardCurves.set(pair, curve);
    }
  }
  for (const curve of forwardCurves.values()) curve.sort((a, b) => a.valueDate.localeCompare(b.valueDate));
  const interpolatedRate = (base: string, quote: string, valueDate: string): Decimal | null => {
    const curve = forwardCurves.get(`${base}|${quote}`);
    if (!curve) return null;
    const upper = curve.findIndex((point) => point.valueDate > valueDate);
    if (upper <= 0) return null;
    const before = curve[upper - 1]!, after = curve[upper]!;
    const days = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 86400000;
    return before.rate.plus(after.rate.minus(before.rate).times(days(valueDate) - days(before.valueDate)).div(days(after.valueDate) - days(before.valueDate))).toDecimalPlaces(10, Decimal.ROUND_HALF_UP);
  };
  const directRate = (base: string, quote: string, kind: string, valueDate: string): Decimal | null => {
    if (base === quote) return new Decimal(1);
    const forward = byRate.get(`${base}|${quote}|${kind}|${valueDate}`);
    if (forward) return new Decimal(forward);
    const reverse = byRate.get(`${quote}|${base}|${kind}|${valueDate}`);
    if (reverse) return new Decimal(1).div(reverse);
    if (kind !== "FORWARD") return null;
    const interpolated = interpolatedRate(base, quote, valueDate);
    if (interpolated) return interpolated;
    const inverse = interpolatedRate(quote, base, valueDate);
    return inverse ? new Decimal(1).div(inverse) : null;
  };
  const convertedRate = (base: string, quote: string, kind: string, valueDate: string): Decimal | null => {
    const direct = directRate(base, quote, kind, valueDate);
    if (direct) return direct;
    const toPivot = directRate(base, "USD", kind, valueDate);
    const fromPivot = directRate("USD", quote, kind, valueDate);
    return toPivot && fromPivot ? toPivot.times(fromPivot) : null;
  };
  const lines = [EXECUTED_HEADER.join(",")];
  let index = 0;
  for (const [ref, rows] of groups) {
    if (!chosen.has(ref)) continue;
    index++;
    const first = rows[0]!;
    const portfolio = input.portfolioByProgram[first.hedging_program_id!];
    if (!portfolio) throw new Error(`no portfolio configured for ${first.hedging_program_id}`);
    for (const row of rows) {
      const deal = row.deal_currency!, settlement = row.settlement_currency!;
      if (deal === settlement) throw new Error(`pre-trade ${ref} has the same deal and settlement currency`);
      const kind = row.instrument === "SPOT" || row.leg === "NEAR" ? "SPOT" : "FORWARD";
      const valueDate = kind === "SPOT" ? "" : row.value_date!;
      const rate = convertedRate(deal, settlement, kind, valueDate);
      if (!rate) throw new Error(`no ${kind} rate for ${deal}/${settlement} on ${input.tradeDate} with value date ${row.value_date}`);
      if (!/^(?:\d+)(?:\.\d+)?$/.test(row.deal_amount!) || !new Decimal(row.deal_amount!).isPositive()) throw new Error(`pre-trade ${ref} has invalid deal amount`);
      const amount = new Decimal(row.deal_amount!).times(rate);
      const values = [
        `SIM-${input.tradeDate}-${createHash("sha256").update(`${input.tradeDate}:${ref}`).digest("hex").slice(0, 24)}`, "SIMFX", row.trading_entity!, BANKS[(index - 1) % BANKS.length]!, input.tradeDate, row.value_date!, deal, row.deal_amount!, settlement,
        amount.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4), row.fixing_date ?? "", row.instrument!, row.buy_sell!, portfolio, row.hedging_program_id!, ref, row.leg!,
      ];
      lines.push(values.map(csvCell).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

function arg(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) throw new Error(`missing ${flag}`);
  return args[i + 1]!;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = JSON.parse(await readFile(args.includes("--config") ? arg(args, "--config") : "packs/uat/config.json", "utf8")) as { simulator?: { portfolioByProgram?: Record<string, string> } };
  const result = simulate({
    pretrades: await readFile(arg(args, "--pretrades"), "utf8"), rates: await readFile(arg(args, "--rates"), "utf8"),
    tradeDate: arg(args, "--trade-date"), seed: arg(args, "--seed"), portfolioByProgram: config.simulator?.portfolioByProgram ?? {},
    partial: args.includes("--partial") ? Number(arg(args, "--partial")) : undefined,
    reject: args.includes("--reject") ? Number(arg(args, "--reject")) : undefined,
  });
  await writeFile(arg(args, "--out"), result, "utf8");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
