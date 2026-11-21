import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Decimal } from "decimal.js";

// Independent calculation from the published decisions. Do not import platform calculation code here.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Amount = InstanceType<typeof D>;
type Entity = { code: string; parent: string; functional: string; legal: boolean };
type Account = { number: string; monetary: boolean; fx: boolean; node: string };
type Rule = { kind: "INCLUDE" | "EXCLUDE"; target: { type: "NODE" | "ACCOUNT"; nodeCode?: string; accountNumber?: string }; entityCode?: string; validFrom: string; validTo: string | null };
type Program = { id: string; settings: { nettingLevel: "ENTITY" | "REGION"; displayCurrency: string; exposureCurrencyOverrides: { pair: string; exposureCurrency: string }[] }; mappingRules: Rule[] };
type Config = { tenants: { program: Program }[] };
type RateMap = Map<string, string>;
type Group = { program: string; level: string; region: string; entity: string; c1: string; c2: string; exposure: string; day: string; gross1: Amount; gross2: Amount; hedge1: Amount; hedge2: Amount };
const ZERO = () => new D(0);
const ROUND = (n: Amount) => { const v = n.toDecimalPlaces(2, D.ROUND_HALF_UP); return v.isZero() ? ZERO() : v; };
const FIX = (n: Amount) => n.toDecimalPlaces(10, D.ROUND_HALF_UP).toFixed(10);
const pairRank = ["EUR", "GBP", "AUD", "NZD", "USD", "CHF", "CAD", "SGD"];
const majors = ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "SGD"];
const HEADER = ["program_id", "netting_level", "region", "entity_code", "pair", "exposure_currency", "period", "gross_currency1", "gross_currency2", "gross_exposure", "gross_display", "hedge_currency1", "hedge_currency2", "hedge_exposure", "hedge_display", "net_currency1", "net_currency2", "net_exposure", "net_display"];

function table(text: string): Record<string, string>[] {
  const lines = text.trimEnd().split(/\r?\n/);
  const header = lines.shift()!.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, i) => [header[i]!, value])));
}
function order(a: string, b: string): [string, string] {
  const ra = pairRank.indexOf(a), rb = pairRank.indexOf(b);
  const rankA = ra < 0 ? pairRank.length : ra, rankB = rb < 0 ? pairRank.length : rb;
  return rankA < rankB || (rankA === rankB && a < b) ? [a, b] : [b, a];
}
function missingRate(base: string, quote: string, day: string): never { throw new Error(`NO_RATE ${base}-${quote} ${day}`); }
function rateOf(rates: RateMap, base: string, quote: string, day: string): string {
  if (base === quote) return "1.0000000000";
  const first = base === "USD" ? new D(1) : new D(rates.get(base) ?? missingRate(base, "USD", day));
  const second = quote === "USD" ? new D(1) : new D(rates.get(quote) ?? missingRate(quote, "USD", day));
  return FIX(first.div(second));
}
function defaultExposure(c1: string, c2: string, ndf: Set<string>): string {
  if (ndf.has(c1) !== ndf.has(c2)) return ndf.has(c1) ? c1 : c2;
  if (ndf.has(c1) && ndf.has(c2)) return c2;
  for (const major of majors) if (c1 === major) return c2; else if (c2 === major) return c1;
  return c2;
}
function regionOf(code: string, entities: Map<string, Entity>): string {
  let current = entities.get(code);
  while (current && current.parent) {
    const parent = entities.get(current.parent);
    if (!parent) break;
    if (["AMER", "EMEA", "APAC", "LATAM"].includes(parent.code)) return parent.code;
    current = parent;
  }
  return "UNASSIGNED";
}
function pathOf(node: string, parents: Map<string, string>): string[] {
  const path: string[] = [];
  let current = node;
  while (current) { path.push(current); current = parents.get(current) ?? ""; }
  return path;
}
function included(row: Record<string, string>, program: Program, account: Account, parents: Map<string, string>, day: string): boolean {
  const path = pathOf(account.node, parents);
  const matches = program.mappingRules.filter((r) => r.validFrom <= day && (r.validTo === null || day < r.validTo) && (!r.entityCode || r.entityCode === row.entity_code) && (r.target.type === "ACCOUNT" ? r.target.accountNumber === account.number : path.includes(r.target.nodeCode ?? "")));
  return matches.some((r) => r.kind === "INCLUDE") && !matches.some((r) => r.kind === "EXCLUDE");
}
function exposureOf(program: Program, c1: string, c2: string, functional: string, deal: string | null, overrides: Map<string, string>, ndf: Set<string>): string {
  if (program.settings.nettingLevel === "ENTITY" && (c1 === functional || c2 === functional)) return c1 === functional ? c2 : c1;
  const override = overrides.get([c1, c2].sort().join("-"));
  if (program.settings.nettingLevel === "ENTITY" && deal !== null) return override ?? deal;
  return override ?? defaultExposure(c1, c2, ndf);
}
function add(groups: Map<string, Group>, program: Program, day: string, region: string, entity: string, c1: string, c2: string, exposure: string, a1: Amount, a2: Amount, kind: "gross" | "hedge"): void {
  const scopedRegion = program.settings.nettingLevel === "REGION" ? region : "";
  const scopedEntity = program.settings.nettingLevel === "ENTITY" ? entity : "";
  const key = [program.id, scopedRegion, scopedEntity, c1, c2, exposure, day].join("\u0000");
  let group = groups.get(key);
  if (!group) {
    group = { program: program.id, level: program.settings.nettingLevel, region: scopedRegion, entity: scopedEntity, c1, c2, exposure, day, gross1: ZERO(), gross2: ZERO(), hedge1: ZERO(), hedge2: ZERO() };
    groups.set(key, group);
  }
  if (kind === "gross") { group.gross1 = group.gross1.plus(a1); group.gross2 = group.gross2.plus(a2); }
  else { group.hedge1 = group.hedge1.plus(a1); group.hedge2 = group.hedge2.plus(a2); }
}
function outputRow(group: Group, rates: RateMap): string[] {
  const displayRate = rateOf(rates, group.c1, "USD", group.day);
  const net1 = group.gross1.plus(group.hedge1), net2 = group.gross2.plus(group.hedge2);
  const exposure = (a: Amount, b: Amount) => group.exposure === group.c1 ? a : b;
  const fmt = (n: Amount) => ROUND(n).toFixed(2);
  return [group.program, group.level, group.region, group.entity, `${group.c1}-${group.c2}`, group.exposure, group.day,
    fmt(group.gross1), fmt(group.gross2), fmt(exposure(group.gross1, group.gross2)), fmt(group.gross1.times(displayRate)),
    fmt(group.hedge1), fmt(group.hedge2), fmt(exposure(group.hedge1, group.hedge2)), fmt(group.hedge1.times(displayRate)),
    fmt(net1), fmt(net2), fmt(exposure(net1, net2)), fmt(net1.times(displayRate))];
}

export async function writeExpected(generated = "packs/uat/generated", configPath = "packs/uat/config.json", out = "packs/uat/expected"): Promise<{ date: string; status: string; rows: number }[]> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
  const manifest = JSON.parse(await readFile(join(generated, "manifest.json"), "utf8")) as { files: { file: string }[] };
  const entities = new Map(table(await readFile(join(generated, "entities.csv"), "utf8")).map((r) => [r.code!, { code: r.code!, parent: r.parent_code!, functional: r.functional_currency!, legal: r.is_legal_entity === "true" }]));
  const accounts = new Map(table(await readFile(join(generated, "accounts.csv"), "utf8")).map((r) => [r.account_number!, { number: r.account_number!, monetary: r.monetary_flag === "true", fx: r.fx_relevant_flag === "true", node: r.hierarchy_node_code! }]));
  const parents = new Map(table(await readFile(join(generated, "hierarchy.csv"), "utf8")).map((r) => [r.code!, r.parent_code!]));
  const ndf = new Set(table(await readFile(join(generated, "currencies.csv"), "utf8")).filter((r) => r.is_ndf === "true").map((r) => r.code!));
  const mappings = new Map(table(await readFile(join(generated, "exposure-currencies.csv"), "utf8")).map((r) => [r.pair!, r.exposure_currency!]));
  const trades = (await Promise.all(config.tenants.map(async (t) => table(await readFile(join(generated, `executed-history-${t.program.id}.csv`), "utf8"))))).flat();
  const glFiles = manifest.files.filter((f) => /^gl\/gl-\d{4}-\d{2}-\d{2}\.csv$/.test(f.file)).sort((a, b) => a.file < b.file ? -1 : 1);
  await mkdir(out, { recursive: true });
  const summary: { date: string; status: string; rows: number }[] = [];
  for (const { file } of glFiles) {
    const day = file.slice(6, 16);
    const rates = new Map(table(await readFile(join(generated, `rates/rates-${day}.csv`), "utf8")).filter((r) => r.type === "SPOT").map((r) => [r.base!, r.all_in!]));
    const balances = table(await readFile(join(generated, file), "utf8"));
    const groups = new Map<string, Group>();
    let waiting: string | null = null;
    try {
      for (const tenant of config.tenants) {
        const program = tenant.program;
        if (program.settings.displayCurrency !== "USD") throw new Error("UAT expected calculator requires USD display currency");
        const overrides = new Map(mappings);
        for (const o of program.settings.exposureCurrencyOverrides) overrides.set(o.pair.split("-").sort().join("-"), o.exposureCurrency);
        for (const row of balances) {
          const entity = entities.get(row.entity_code!);
          const account = accounts.get(row.account_number!);
          if (!entity?.legal || !account || !included(row, program, account, parents, day) || !account.monetary || !account.fx || row.currency === entity.functional) continue;
          const [c1, c2] = order(row.currency!, entity.functional);
          const pairRate = rateOf(rates, c1, c2, day);
          const amount = new D(row.balance!);
          const other = ROUND(entity.functional === c1 ? amount.div(pairRate) : amount.times(pairRate)).negated();
          const a1 = row.currency === c1 ? amount : other;
          const a2 = row.currency === c1 ? other : amount;
          const exposure = exposureOf(program, c1, c2, entity.functional, null, overrides, ndf);
          add(groups, program, day, regionOf(entity.code, entities), entity.code, c1, c2, exposure, a1, a2, "gross");
        }
        for (const trade of trades) {
          if (trade.hedging_program_id !== program.id || trade.trade_date! > day || trade.value_date! <= day) continue;
          const entity = entities.get(trade.trading_entity!);
          if (!entity) continue;
          const [c1, c2] = order(trade.deal_currency!, trade.settlement_currency!);
          const direction = trade.buy_sell === "BUY" ? new D(1) : new D(-1);
          const deal = ROUND(new D(trade.deal_amount!).times(direction));
          const settlement = ROUND(new D(trade.settlement_amount!).times(direction).negated());
          const a1 = trade.deal_currency === c1 ? deal : settlement;
          const a2 = trade.deal_currency === c1 ? settlement : deal;
          const exposure = exposureOf(program, c1, c2, entity.functional, trade.deal_currency!, overrides, ndf);
          add(groups, program, day, regionOf(entity.code, entities), entity.code, c1, c2, exposure, a1, a2, "hedge");
        }
      }
      const rows = [...groups.values()].map((g) => outputRow(g, rates));
      rows.sort((a, b) => a.join("\u0000") < b.join("\u0000") ? -1 : 1);
      await writeFile(join(out, `${day}.csv`), `${[HEADER, ...rows].map((r) => r.join(",")).join("\n")}\n`, "utf8");
      summary.push({ date: day, status: "COMPLETE", rows: rows.length });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NO_RATE ")) throw error;
      waiting = error.message;
      await writeFile(join(out, `${day}.csv`), `${HEADER.join(",")}\n`, "utf8");
      summary.push({ date: day, status: waiting, rows: 0 });
    }
  }
  await writeFile(join(out, "expected-status.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const dirty = table(await readFile(join(generated, "gl-dirty.csv"), "utf8"));
  const totals = (rows: Record<string, string>[]) => {
    const byCurrency: Record<string, { rows: number; balance: string }> = {};
    for (const row of rows) {
      const currency = row.currency!;
      const prior = byCurrency[currency];
      byCurrency[currency] = { rows: (prior?.rows ?? 0) + 1, balance: new D(prior?.balance ?? 0).plus(row.balance!).toFixed(2) };
    }
    return Object.fromEntries(Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b)));
  };
  const byProgram: Record<string, { included: ReturnType<typeof totals>; excluded: ReturnType<typeof totals>; blocked: ReturnType<typeof totals>; byReason: Record<string, ReturnType<typeof totals>> }> = {};
  for (const { program } of config.tenants) {
    const classified: Record<string, Record<string, string>[]> = {};
    for (const row of dirty) {
      const entity = entities.get(row.entity_code!);
      const account = accounts.get(row.account_number!);
      let reason: string;
      if (!entity) reason = "GL_ENTITY_UNKNOWN";
      else if (!account) reason = "GL_ACCOUNT_UNKNOWN";
      else if (!account.fx || !account.monetary) reason = "NONFX";
      else if (row.entity_code === "LE45") reason = "LE45";
      else if (!included(row, program, account, parents, row.as_of!)) reason = account.number === "1900" ? "ACCOUNT_1900" : "OTHER_MAPPING";
      else reason = "INCLUDED";
      (classified[reason] ??= []).push(row);
    }
    const pick = (reasons: string[]) => reasons.flatMap((reason) => classified[reason] ?? []);
    const excludedReasons = Object.keys(classified).filter((reason) => !["INCLUDED", "GL_ENTITY_UNKNOWN", "GL_ACCOUNT_UNKNOWN"].includes(reason)).sort();
    byProgram[program.id] = { included: totals(pick(["INCLUDED"])), excluded: totals(pick(excludedReasons)), blocked: totals(pick(["GL_ENTITY_UNKNOWN", "GL_ACCOUNT_UNKNOWN"])), byReason: Object.fromEntries(excludedReasons.concat(["GL_ENTITY_UNKNOWN", "GL_ACCOUNT_UNKNOWN"]).map((reason) => [reason, totals(pick([reason]))])) };
  }
  await writeFile(join(out, "gl-dirty-expected.json"), `${JSON.stringify({ loadStatus: "APPLIED", storedRows: dirty.length, batchControlTotals: totals(dirty), byProgram }, null, 2)}\n`, "utf8");
  return summary;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/uat/expected.ts")) {
  const options = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error(`expected value for ${argv[i]}`);
    options.set(argv[i]!, argv[i + 1]!);
  }
  for (const key of options.keys()) if (!["--generated", "--config", "--out"].includes(key)) throw new Error(`unknown option ${key}`);
  writeExpected(options.get("--generated"), options.get("--config"), options.get("--out"))
    .then((summary) => console.log(`Expected results: ${summary.filter((x) => x.status === "COMPLETE").length} complete days, ${summary.filter((x) => x.status !== "COMPLETE").length} waiting days`))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
