// Command-line file loader (stream D5): thin shell over the D4 loaders in app/src/loaders/.
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asOfDate, tenantId, type AsOfDate, type TenantId } from "@shared/kernel";
import { composeApp as defaultComposeApp, type App } from "../compose.ts";
import { deliveryProblems, drain as defaultDrain } from "../dispatch.ts";
import {
  loadAccountsFile,
  loadCalendarsFile,
  loadCurrenciesFile,
  loadEntitiesFile,
  loadExecutedFile,
  loadExposureCurrenciesFile,
  loadGlFile,
  loadHierarchyFile,
  loadRatesFile,
  type FileProblem,
  type LoadOutcome,
} from "../loaders/index.ts";

export const KINDS = [
  "entities",
  "hierarchy",
  "accounts",
  "currencies",
  "calendars",
  "exposure-currencies",
  "gl",
  "rates",
  "executed",
] as const;

export type Kind = (typeof KINDS)[number];

export type ExitCode = 0 | 1 | 2 | 3 | 4;

const PROBLEM_LIMIT = 50;

export interface ParsedArgs {
  readonly kind: Kind;
  readonly file: string;
  readonly tenant: string;
  readonly by: string;
  readonly dryRun: boolean;
  readonly drain: boolean;
  readonly source: string | undefined;
  readonly asOf: string | undefined;
  readonly mode: string | undefined;
  readonly program: string | undefined;
  readonly chart: string | undefined;
  readonly businessDate: string | undefined;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v);
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new CliUsageError(`missing value for ${name}`);
  return v;
}

function requireOption(args: string[], name: string): string {
  const v = option(args, name);
  if (v === undefined) throw new CliUsageError(`missing ${name}`);
  return v;
}

/** Parses `load <kind> <file> --tenant <id> [options]`. Throws CliUsageError on bad shape. */
export function parseArgs(argv: readonly string[], defaultBy: string): ParsedArgs {
  const args = [...argv];
  const dryRun = flag(args, "--dry-run");
  const doDrain = flag(args, "--drain");
  // Strip known flags/options so positionals are kind and file.
  const strip = new Set([
    "--dry-run",
    "--drain",
    "--tenant",
    "--by",
    "--source",
    "--as-of",
    "--mode",
    "--program",
    "--chart",
    "--business-date",
  ]);
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run" || a === "--drain") continue;
    if (strip.has(a)) {
      i++; // skip value
      continue;
    }
    if (a.startsWith("--")) throw new CliUsageError(`unknown option ${a}`);
    positionals.push(a);
  }
  if (positionals.length < 2) throw new CliUsageError("usage: load <kind> <file> --tenant <id> [options]");
  if (positionals.length > 2) throw new CliUsageError(`unexpected argument ${positionals[2]}`);
  const kindRaw = positionals[0]!;
  if (!isKind(kindRaw)) throw new CliUsageError(`unknown kind ${kindRaw}; expected one of ${KINDS.join(", ")}`);
  const file = positionals[1]!;
  const tenant = requireOption(args, "--tenant");
  const by = option(args, "--by") ?? defaultBy;
  return {
    kind: kindRaw,
    file,
    tenant,
    by,
    dryRun,
    drain: doDrain,
    source: option(args, "--source"),
    asOf: option(args, "--as-of"),
    mode: option(args, "--mode"),
    program: option(args, "--program"),
    chart: option(args, "--chart"),
    businessDate: option(args, "--business-date"),
  };
}

function requireText(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new CliUsageError(`missing ${name}`);
  return value;
}

function parseMode(value: string | undefined): "SNAPSHOT" | "PARTIAL" {
  const mode = requireText("--mode", value);
  if (mode !== "SNAPSHOT" && mode !== "PARTIAL") {
    throw new CliUsageError(`--mode must be SNAPSHOT or PARTIAL`);
  }
  return mode;
}

function parseTenant(value: string): TenantId {
  try {
    return tenantId(value);
  } catch {
    throw new CliUsageError("--tenant must be a UUID");
  }
}

function parseAsOf(flagName: string, value: string | undefined): AsOfDate {
  const raw = requireText(flagName, value);
  try {
    return asOfDate(raw);
  } catch {
    throw new CliUsageError(`${flagName} must be a real date written YYYY-MM-DD`);
  }
}

/** Stub app so dry-run can reuse D4 loaders without touching a database. */
export function dryRunApp(): App {
  const md = async () => ({
    status: "APPLIED" as const,
    batchId: "dry-run",
    created: 0,
    changed: 0,
    ended: 0,
    unchanged: 0,
  });
  const gl = async () => ({
    status: "APPLIED" as const,
    batchId: "dry-run",
    ingestion: "COMPLETE" as const,
    received: 0,
    included: 0,
    excluded: 0,
    blocked: 0,
  });
  const rates = async () => ({
    status: "APPLIED" as const,
    loadId: "dry-run",
    accepted: 0,
    flagged: 0,
  });
  const executed = async () => ({
    status: "APPLIED" as const,
    batchId: "dry-run",
    received: 0,
    stored: 0,
    unchanged: 0,
    blocked: 0,
    matched: 0,
    unmatched: 0,
  });
  return {
    masterData: {
      commands: {
        applyEntities: md,
        applyHierarchy: md,
        applyAccounts: md,
        applyCurrencies: md,
        applyCalendars: md,
        applyPairExposureCurrencies: md,
      },
    },
    dataSource: { commands: { submitGlBatch: gl } },
    fxRate: { commands: { loadRates: rates } },
    fxTrade: { commands: { importExecutedTrades: executed } },
  } as unknown as App;
}

async function runLoader(app: App, parsed: ParsedArgs, text: string): Promise<LoadOutcome> {
  const tid = parseTenant(parsed.tenant);
  const by = parsed.by;
  switch (parsed.kind) {
    case "entities":
    case "hierarchy":
    case "accounts":
    case "currencies":
    case "calendars": {
      const opts = {
        tenantId: tid,
        text,
        sourceSystem: requireText("--source", parsed.source),
        asOf: parseAsOf("--as-of", parsed.asOf),
        mode: parseMode(parsed.mode),
        by,
      };
      if (parsed.kind === "entities") return loadEntitiesFile(app, opts);
      if (parsed.kind === "hierarchy") return loadHierarchyFile(app, opts);
      if (parsed.kind === "accounts") return loadAccountsFile(app, opts);
      if (parsed.kind === "currencies") return loadCurrenciesFile(app, opts);
      return loadCalendarsFile(app, opts);
    }
    case "exposure-currencies":
      return loadExposureCurrenciesFile(app, {
        tenantId: tid,
        text,
        sourceSystem: requireText("--source", parsed.source),
        asOf: parseAsOf("--as-of", parsed.asOf),
        mode: parseMode(parsed.mode),
        by,
        programCode: requireText("--program", parsed.program),
      });
    case "gl":
      return loadGlFile(app, {
        tenantId: tid,
        text,
        chartCode: requireText("--chart", parsed.chart),
        asOf: parseAsOf("--as-of", parsed.asOf),
        sourceSystem: requireText("--source", parsed.source),
        by,
      });
    case "rates":
      return loadRatesFile(app, {
        tenantId: tid,
        text,
        source: requireText("--source", parsed.source),
        businessDate: parseAsOf("--business-date", parsed.businessDate),
        by,
      });
    case "executed":
      return loadExecutedFile(app, { tenantId: tid, text, by });
  }
}

function formatProblem(p: FileProblem): string {
  const parts: string[] = [];
  if (p.rowNo !== null) parts.push(`row ${p.rowNo}`);
  if (p.column !== null) parts.push(`column ${p.column}`);
  const where = parts.length > 0 ? `${parts.join(", ")}: ` : "";
  return `${where}${p.message}`;
}

const OUTBOX_SERVICES = [
  (app: App) => app.identity,
  (app: App) => app.masterData,
  (app: App) => app.fxRate,
  (app: App) => app.dataSource,
  (app: App) => app.exposureManagement,
  (app: App) => app.exposureAnalysis,
  (app: App) => app.fxTrade,
  (app: App) => app.hedgeRecommendation,
] as const;

/** Counts this tenant's undelivered outbox after a drain (Decision 0019: failed stay for retry). */
export async function countUndelivered(
  app: App,
  tenant: string,
): Promise<{ readonly pending: number; readonly failed: number }> {
  let pending = 0;
  for (const service of OUTBOX_SERVICES) {
    const events = (await service(app).outbox.pending(200)) as ReadonlyArray<{ readonly tenantId?: string }>;
    for (const e of events) {
      if (e.tenantId === tenant) pending++;
    }
  }
  const failed = (await deliveryProblems(app)).filter((p) => p.tenantId === tenant).length;
  return { pending, failed };
}

/** One summary line, then up to 50 problems (never row contents or raw service refusal text). */
export function formatOutput(
  kind: Kind,
  outcome: LoadOutcome,
  options: { dryRun?: boolean; drained?: number; deliveryIncomplete?: boolean } = {},
): { readonly exitCode: ExitCode; readonly lines: string[] } {
  const dry = options.dryRun === true;
  const drainSuffix = options.drained !== undefined ? ` drained=${options.drained}` : "";
  const deliveryNote = "delivery did not finish (load committed; events pending or failed for retry)";

  if (outcome.kind === "INVALID_FILE") {
    const problems = outcome.problems;
    const shown = problems.slice(0, PROBLEM_LIMIT);
    const lines = [`${kind}: INVALID_FILE problems=${problems.length}${drainSuffix}`, ...shown.map(formatProblem)];
    if (problems.length > PROBLEM_LIMIT) {
      lines.push(`and ${problems.length - PROBLEM_LIMIT} more`);
    }
    return { exitCode: 1, lines };
  }

  if (outcome.kind === "REFUSED") {
    // Safe summary only: service refusal text can name rejected row values (entity/account codes, pairs).
    return { exitCode: 2, lines: [`${kind}: REFUSED${drainSuffix}`] };
  }

  if (outcome.kind === "HELD") {
    // Reason is the safeguard summary (counts only), not rejected row values.
    const lines = [`${kind}: HELD batchId=${outcome.batchId} reason=${outcome.reason}${drainSuffix}`];
    if (options.deliveryIncomplete) {
      lines.push(deliveryNote);
      return { exitCode: 3, lines };
    }
    return { exitCode: 4, lines };
  }

  // DONE
  if (dry) {
    return { exitCode: 0, lines: [`${kind}: OK (dry-run)${drainSuffix}`] };
  }
  const counts = Object.entries(outcome.counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const summary = `${kind}: ${outcome.status}${counts ? ` ${counts}` : ""}${drainSuffix}`;
  if (options.deliveryIncomplete) {
    return { exitCode: 3, lines: [summary, deliveryNote] };
  }
  return { exitCode: 0, lines: [summary] };
}
export interface LoadCliResult {
  readonly exitCode: ExitCode;
  readonly lines: string[];
}

function defaultBy(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return "cli:unknown";
  }
}

export interface LoadDeps {
  readonly defaultBy?: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly composeApp?: (connectionString: string) => App;
  readonly drain?: (app: App) => Promise<number>;
  readonly countUndelivered?: (app: App, tenantId: string) => Promise<{ pending: number; failed: number }>;
}

/** Runs one load from argv-like args. DATABASE_URL from env unless --dry-run. */
export async function runLoad(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadDeps = {},
): Promise<LoadCliResult> {
  const byDefault = options.defaultBy ?? defaultBy();
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const compose = options.composeApp ?? defaultComposeApp;
  const drainOnce = options.drain ?? defaultDrain;
  const undelivered = options.countUndelivered ?? countUndelivered;

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, byDefault);
  } catch (e) {
    if (e instanceof CliUsageError) return { exitCode: 3, lines: [e.message] };
    throw e;
  }

  let text: string;
  try {
    text = await read(parsed.file);
  } catch {
    return { exitCode: 3, lines: ["cannot read file"] };
  }

  if (parsed.dryRun) {
    try {
      const outcome = await runLoader(dryRunApp(), parsed, text);
      return formatOutput(parsed.kind, outcome, { dryRun: true });
    } catch (e) {
      if (e instanceof CliUsageError) return { exitCode: 3, lines: [e.message] };
      return { exitCode: 3, lines: ["load failed"] };
    }
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return { exitCode: 3, lines: ["DATABASE_URL is required"] };

  const app = compose(databaseUrl);
  try {
    let outcome: LoadOutcome;
    try {
      outcome = await runLoader(app, parsed, text);
    } catch (e) {
      if (e instanceof CliUsageError) return { exitCode: 3, lines: [e.message] };
      return { exitCode: 3, lines: ["load failed"] };
    }

    let drained: number | undefined;
    let deliveryIncomplete = false;
    if (parsed.drain && (outcome.kind === "DONE" || outcome.kind === "HELD")) {
      drained = await drainOnce(app);
      const left = await undelivered(app, parseTenant(parsed.tenant));
      deliveryIncomplete = left.pending > 0 || left.failed > 0;
    }

    return formatOutput(parsed.kind, outcome, { drained, deliveryIncomplete });
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const result = await runLoad(process.argv.slice(2));
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("load failed");
    process.exitCode = 3;
  });
}
