import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Decimal } from "decimal.js";

type CurrencyChoice = { code: string; initialUsdRate: string; dailyVolatilityBps: string; annualInterestPct: string; isNdf?: boolean; weekendDays?: string };
type GeneratorChoice = { endDate: string; rateStartDate: string; chartCode: string; rateSource: string; currencies: CurrencyChoice[] };
type Config = { generator: GeneratorChoice; tenants: { program: { id: string } }[] };
type ManifestFile = { file: string; rows: number; sha256: string };

const GL_HEADER = ["entity_code", "account_number", "currency", "balance", "debit", "credit", "as_of", "cost_center"];
const RATE_HEADER = ["base", "quote", "type", "tenor", "value_date", "all_in", "spot", "forward_points", "bid", "mid", "ask", "observed_at"];
const EXECUTED_HEADER = ["trade_id", "execution_platform_id", "trading_entity", "counterparty", "trade_date", "value_date", "deal_currency", "deal_amount", "settlement_currency", "settlement_amount", "fixing_date", "instrument", "buy_sell", "portfolio", "hedging_program_id", "pre_trade_reference", "leg"];
const DAY = 86400000;

function args(argv: string[]): { seed: number; out: string; config: string } {
  const a = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`expected value for ${key ?? "option"}`);
    a.set(key, value);
  }
  const seedText = a.get("--seed");
  if (!seedText || !/^\d+$/.test(seedText) || !Number.isSafeInteger(Number(seedText))) throw new Error("--seed must be a non-negative safe integer");
  if (!a.get("--out")) throw new Error("--out is required");
  for (const key of a.keys()) if (!["--seed", "--out", "--config"].includes(key)) throw new Error(`unknown option ${key}`);
  return { seed: Number(seedText), out: a.get("--out")!, config: a.get("--config") ?? "packs/uat/config.json" };
}

function rng(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state % limit;
  };
}

function dateMs(day: string): number { return Date.parse(`${day}T00:00:00Z`); }
function dayAt(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function addDays(day: string, n: number): string { return dayAt(dateMs(day) + n * DAY); }
function businessDates(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = dateMs(start); ms <= dateMs(end); ms += DAY) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(dayAt(ms));
  }
  return days;
}
function calendarMonths(day: string, months: number): string {
  const d = new Date(dateMs(day));
  const original = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(original, last));
  return dayAt(d.getTime());
}
function addMonths(day: string, months: number): string {
  const d = new Date(dateMs(calendarMonths(day, months)));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return dayAt(d.getTime());
}
function forwardValueDate(day: string, months: number, currency: CurrencyChoice, euroHoliday: string): string {
  const unadjusted = calendarMonths(day, months);
  const closed = (value: string): boolean => {
    const weekday = new Date(dateMs(value)).getUTCDay();
    const usdClosed = weekday === 0 || weekday === 6;
    const currencyClosed = (currency.weekendDays === "FRI|SAT" ? weekday === 5 || weekday === 6 : weekday === 0 || weekday === 6) || (currency.code === "EUR" && value === euroHoliday);
    return usdClosed || currencyClosed;
  };
  let forward = unadjusted;
  while (closed(forward)) forward = addDays(forward, 1);
  if (forward.slice(0, 7) === unadjusted.slice(0, 7)) return forward;
  let backward = unadjusted;
  while (closed(backward)) backward = addDays(backward, -1);
  return backward;
}
function csv(rows: string[][]): string { return `${rows.map((r) => r.map((v) => /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v).join(",")).join("\n")}\n`; }
function money(value: Decimal, currency: string): string { return value.toDecimalPlaces(currency === "JPY" || currency === "KRW" ? 0 : 2).toFixed(currency === "JPY" || currency === "KRW" ? 0 : 2); }
function rate(value: Decimal): string { return value.toDecimalPlaces(10).toFixed(10); }

function validate(config: Config): void {
  const g = config.generator;
  if (!g || !/^\d{4}-\d{2}-\d{2}$/.test(g.endDate) || !/^\d{4}-\d{2}-\d{2}$/.test(g.rateStartDate) || !g.chartCode || !g.rateSource) throw new Error("generator config is incomplete");
  if (g.currencies.length !== 40 || !g.currencies.some((c) => c.code === "USD") || g.currencies.filter((c) => c.isNdf).length < 6) throw new Error("generator requires 40 currencies, USD and at least six NDF currencies");
  if (new Set(g.currencies.map((c) => c.code)).size !== 40) throw new Error("duplicate currency in generator config");
  if (g.currencies.filter((c) => c.weekendDays === "FRI|SAT").length < 2) throw new Error("two currencies need Friday/Saturday weekends");
  for (const c of g.currencies) {
    if (!/^[A-Z]{3}$/.test(c.code) || new Decimal(c.initialUsdRate).lte(0) || new Decimal(c.dailyVolatilityBps).lt(0) || new Decimal(c.annualInterestPct).lt(0)) throw new Error(`invalid currency choice ${c.code}`);
  }
  if (config.tenants.length !== 2 || new Set(config.tenants.map((t) => t.program.id)).size !== 2) throw new Error("generator requires two distinct program IDs");
}

export async function generate(seed: number, out: string, configPath = "packs/uat/config.json"): Promise<ManifestFile[]> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as Config;
  validate(config);
  const g = config.generator;
  const random = rng(seed);
  const files: ManifestFile[] = [];
  await mkdir(out, { recursive: true });
  async function save(name: string, rows: string[][]): Promise<void> {
    const body = csv(rows);
    const target = join(out, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, body, "utf8");
    files.push({ file: name.replaceAll("\\", "/"), rows: rows.length - 1, sha256: createHash("sha256").update(body).digest("hex") });
  }

  const currencyCodes = g.currencies.map((c) => c.code);
  const entityCodes = [...Array.from({ length: 41 }, (_, i) => `LE${String(i + 1).padStart(2, "0")}`), "LE45", "EX01", "EX02", "TR01"];
  const regions = ["AMER", "EMEA", "APAC", "LATAM"];
  const entities: string[][] = [["code", "name", "type", "parent_code", "country_code", "functional_currency", "is_legal_entity", "is_treasury_entity", "is_hedge_execution_entity"],
    ["G", "Northstar Meridian Group (fictional)", "GROUP", "", "", "", "false", "false", "false"],
    ...regions.map((r) => [r, `${r} Region`, "REGION", "G", "", "", "false", "false", "false"])];
  entityCodes.forEach((code, i) => entities.push([code, `Northstar Meridian ${code} (fictional)`, "LEGAL_ENTITY", regions[i % 4]!, "", currencyCodes[i % 40]!, "true", ["EX01", "EX02", "TR01"].includes(code) ? "true" : "false", ["EX01", "EX02"].includes(code) ? "true" : "false"]));
  await save("entities.csv", entities);

  const hierarchy: string[][] = [["chart_code", "code", "name", "classification", "parent_code"], [g.chartCode, "BS", "Balance sheet", "BALANCE_SHEET", ""], [g.chartCode, "FX", "FX relevant", "ASSETS", "BS"], [g.chartCode, "NONFX", "Other balance sheet", "ASSETS", "BS"]];
  for (let i = 1; i <= 11; i++) hierarchy.push([g.chartCode, `FXA${i}`, `FX asset group ${i}`, "ASSETS", "FX"]);
  for (let i = 1; i <= 11; i++) hierarchy.push([g.chartCode, `FXL${i}`, `FX liability group ${i}`, "LIABILITIES", "FX"]);
  await save("hierarchy.csv", hierarchy);

  const accounts: string[][] = [["chart_code", "account_number", "name", "statement_type", "normal_balance", "monetary_flag", "fx_relevant_flag", "hierarchy_node_code"]];
  for (let i = 0; i < 30; i++) accounts.push([g.chartCode, String(1000 + i * 10), i < 15 ? `Receivable and cash ${i + 1}` : `Payable and funding ${i - 14}`, "BALANCE_SHEET", i < 15 ? "DEBIT" : "CREDIT", "true", "true", i < 15 ? `FXA${i % 11 + 1}` : `FXL${i % 11 + 1}`]);
  accounts[11]![1] = "1900";
  for (let i = 0; i < 10; i++) accounts.push([g.chartCode, String(8000 + i), `Non FX asset ${i + 1}`, "BALANCE_SHEET", "DEBIT", "false", "false", "NONFX"]);
  await save("accounts.csv", accounts);
  await save("currencies.csv", [["code", "is_ndf"], ...g.currencies.map((c) => [c.code, c.isNdf ? "true" : "false"])]);

  const holiday = addMonths(g.endDate, 3);
  await save("calendars.csv", [["currency_code", "weekend_days", "covered_through", "holiday_date", "holiday_name"], ...g.currencies.map((c) => [c.code, c.weekendDays ?? "SAT|SUN", addMonths(g.endDate, 24), c.code === "EUR" ? holiday : "", c.code === "EUR" ? "Illustrative UAT holiday" : ""])]);
  await save("exposure-currencies.csv", [["pair", "exposure_currency"], ...g.currencies.filter((c) => c.code !== "USD").map((c) => [`${[c.code, "USD"].sort().join("-")}`, "USD"])]);

  const rateDays = businessDates(g.rateStartDate, g.endDate);
  const spot = new Map(g.currencies.filter((c) => c.code !== "USD").map((c) => [c.code, new Decimal(c.initialUsdRate)]));
  const spotByDay = new Map<string, Map<string, Decimal>>();
  const missing = { date: addDays(g.endDate, -8), currency: "EUR" };
  const stale = { date: addDays(g.endDate, -7), currency: "GBP" };
  const outlier = { date: addDays(g.endDate, -4), currency: "AUD" };
  for (const day of rateDays) {
    const rows: string[][] = [RATE_HEADER];
    const dayRates = new Map<string, Decimal>();
    for (const c of g.currencies) {
      if (c.code === "USD") continue;
      const prior = spot.get(c.code)!;
      const changeBps = new Decimal(random(2001) - 1000).div(1000).times(c.dailyVolatilityBps);
      const current = prior.times(new Decimal(1).plus(changeBps.div(10000))).toDecimalPlaces(10);
      spot.set(c.code, current);
      const published = day === outlier.date && c.code === outlier.currency ? current.times("1.25").toDecimalPlaces(10) : current;
      dayRates.set(c.code, published);
      if (day === missing.date && c.code === missing.currency) continue;
      const observed = `${day === stale.date && c.code === stale.currency ? addDays(day, -1) : day}T16:30:00Z`;
      rows.push([c.code, "USD", "SPOT", "SPOT", "", rate(published), "", "", "", "", "", observed]);
      for (const [tenor, months] of [["1M", 1], ["3M", 3], ["6M", 6], ["12M", 12]] as const) {
        const usdInterest = new Decimal(g.currencies.find((x) => x.code === "USD")!.annualInterestPct);
        const differential = usdInterest.minus(c.annualInterestPct).div(100).times(months).div(12);
        const allIn = published.times(new Decimal(1).plus(differential)).toDecimalPlaces(10);
        rows.push([c.code, "USD", "FORWARD", tenor, forwardValueDate(day, months, c, holiday), rate(allIn), rate(published), rate(allIn.minus(published)), "", "", "", observed]);
      }
    }
    spotByDay.set(day, dayRates);
    await save(`rates/rates-${day}.csv`, rows);
  }

  const glDays = rateDays.slice(-20);
  if (glDays.length !== 20) throw new Error("rate span must cover at least 20 business days");
  const baseline = Array.from({ length: 20000 }, () => new Decimal(10000 + random(890000)));
  const dailyDriftBps = Array.from({ length: 20000 }, () => random(201) - 100);
  let lastGl: string[][] = [];
  for (let dayIndex = 0; dayIndex < glDays.length; dayIndex++) {
    const day = glDays[dayIndex]!;
    const rows: string[][] = [GL_HEADER];
    for (let i = 0; i < 20000; i++) {
      const entityIndex = i % entityCodes.length;
      const ordinal = Math.floor(i / entityCodes.length);
      const entity = entityCodes[entityIndex]!;
      const functional = currencyCodes[entityIndex % 40]!;
      const currency = ordinal % 10 === 0 ? functional : currencyCodes[(entityIndex + 1 + Math.floor(ordinal / 20) % 9) % 40]!;
      const nonFx = ordinal % 20 === 19;
      const account = nonFx ? accounts[31 + (Math.floor(ordinal / 20) % 10)]![1]! : accounts[1 + (ordinal % 19 + entityIndex) % 30]![1]!;
      const direction = nonFx || ordinal % 4 < 2 ? 1 : -1;
      const drift = new Decimal(10000 + dayIndex * dailyDriftBps[i]!).div(10000);
      let amount = baseline[i]!.times(drift).times(direction);
      if (currency === "EUR" && dayIndex >= 18) amount = amount.abs().times(dayIndex === 18 ? 1 : -1);
      rows.push([entity, account, currency, money(amount, currency), "", "", day, `CC-${Math.floor(ordinal / 180) + 1}`]);
    }
    await save(`gl/gl-${day}.csv`, rows);
    lastGl = rows;
  }

  const malformed = lastGl.map((r) => [...r]);
  const badKinds = ["balance_with_debit", "no_amount", "bad_date", "bad_currency", "non_numeric", "missing_entity"];
  const malformedProblems: { row: number; column: string; kind: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const row = malformed[i + 1]!;
    const kind = badKinds[i % badKinds.length]!;
    if (kind === "balance_with_debit") row[4] = "1.00";
    if (kind === "no_amount") row[3] = "";
    if (kind === "bad_date") row[6] = "2026-99-99";
    if (kind === "bad_currency") row[2] = "EURO";
    if (kind === "non_numeric") row[3] = "NaN";
    if (kind === "missing_entity") row[0] = "";
    malformedProblems.push({ row: i + 1, column: ({ balance_with_debit: "balance", no_amount: "balance", bad_date: "as_of", bad_currency: "currency", non_numeric: "balance", missing_entity: "entity_code" } as Record<string, string>)[kind]!, kind });
  }
  await save("gl-malformed.csv", malformed);
  const dirty = lastGl.map((r) => [...r]);
  for (let i = 0; i < 10; i++) dirty[i + 1]![0] = `UNKNOWN${i + 1}`;
  for (let i = 10; i < 20; i++) dirty[i + 1]![1] = `UNKNOWN${i + 1}`;
  for (let i = 20; i < 30; i++) dirty[i + 1]![1] = "8009";
  await save("gl-dirty.csv", dirty);

  const histories = new Map(config.tenants.map((t) => [t.program.id, [EXECUTED_HEADER]]));
  let tradeNo = 0;
  for (const day of rateDays) {
    const rates = spotByDay.get(day)!;
    const currency = ["EUR", "GBP", "JPY", "CAD", "AUD"][tradeNo % 5]!;
    const amount = new Decimal(100000 + random(900000));
    const settlement = amount.times(rates.get(currency)!);
    const program = config.tenants[tradeNo % config.tenants.length]!.program.id;
    histories.get(program)!.push([`HIST-${String(++tradeNo).padStart(5, "0")}`, "SIMFX", "EX01", "Fictional Meridian Bank", day, addMonths(day, 3), currency, money(amount, currency), "USD", money(settlement, "USD"), "", "FORWARD", tradeNo % 2 === 0 ? "BUY" : "SELL", `DEMO-${program}`, program, "", "SINGLE"]);
  }
  for (const [program, history] of histories) await save(`executed-history-${program}.csv`, history);

  files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const manifest = { seed, config: relative(process.cwd(), configPath).replaceAll("\\", "/"), dates: { ratesFrom: rateDays[0], ratesThrough: rateDays.at(-1), glFrom: glDays[0], glThrough: glDays.at(-1) }, planted: { missing, stale, outlier, holiday: { date: holiday, currency: "EUR", adjustedForwardDate: forwardValueDate(g.endDate, 3, g.currencies.find((c) => c.code === "EUR")!, holiday) }, lateGl: { date: "2026-10-27", file: "gl/gl-2026-10-27.csv", loadAfterCycleStart: true }, flip: { currency: "EUR", from: glDays[18], to: glDays[19] }, excludedEntity: "LE45" }, malformedProblems, dirtyChanges: { unknownEntity: 10, unknownAccount: 10, excludedAccount: 10 }, files };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return files;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/uat/generate.ts")) {
  const options = args(process.argv.slice(2));
  generate(options.seed, options.out, options.config).then((files) => console.log(`Generated ${files.length} files in ${options.out}`)).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
