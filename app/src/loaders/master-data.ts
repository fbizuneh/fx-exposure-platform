// Master Data file loaders: parse, then apply through the service entry point (never its tables).
import type { AsOfDate, TenantId } from "@shared/kernel";
import {
  ChangeSetInvalid,
  ChangeSetRefused,
  parseAccountsFile,
  parseCalendarsFile,
  parseCurrenciesFile,
  parseEntitiesFile,
  parseExposureCurrenciesFile,
  parseHierarchyFile,
  type SubmitResult,
} from "../../../services/master-data/src/index.ts";
import type { App } from "../compose.ts";
import type { FileProblem, LoadOutcome } from "./outcome.ts";

type Mode = "SNAPSHOT" | "PARTIAL";

export interface MasterDataLoadOptions {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly sourceSystem: string;
  readonly asOf: AsOfDate;
  readonly mode: Mode;
  readonly by: string;
}

export interface ExposureCurrencyLoadOptions extends MasterDataLoadOptions {
  readonly programCode: string;
}

function fromSubmit(result: SubmitResult): LoadOutcome {
  if (result.status === "HELD") {
    return { kind: "HELD", batchId: result.batchId, reason: result.heldReason ?? "" };
  }
  return {
    kind: "DONE",
    status: result.status,
    counts: {
      created: result.created,
      changed: result.changed,
      ended: result.ended,
      unchanged: result.unchanged,
    },
  };
}

function refused(e: unknown): LoadOutcome | null {
  // ChangeSetInvalid is the Master Data counterpart of RatesInvalid (validation refused whole).
  if (e instanceof ChangeSetRefused || e instanceof ChangeSetInvalid) {
    return { kind: "REFUSED", message: e.message };
  }
  return null;
}

async function loadMasterDataFile<R>(
  text: string,
  parse: (text: string) => { rows: R[]; problems: FileProblem[] },
  apply: (rows: R[]) => Promise<SubmitResult>,
): Promise<LoadOutcome> {
  const parsed = parse(text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(await apply(parsed.rows));
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export function loadEntitiesFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseEntitiesFile, (rows) =>
    app.masterData.commands.applyEntities({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
    }),
  );
}

export function loadHierarchyFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseHierarchyFile, (rows) =>
    app.masterData.commands.applyHierarchy({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
    }),
  );
}

export function loadAccountsFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseAccountsFile, (rows) =>
    app.masterData.commands.applyAccounts({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
    }),
  );
}

export function loadCurrenciesFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseCurrenciesFile, (rows) =>
    app.masterData.commands.applyCurrencies({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
    }),
  );
}

export function loadCalendarsFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseCalendarsFile, (rows) =>
    app.masterData.commands.applyCalendars({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
    }),
  );
}

export function loadExposureCurrenciesFile(app: App, opts: ExposureCurrencyLoadOptions): Promise<LoadOutcome> {
  return loadMasterDataFile(opts.text, parseExposureCurrenciesFile, (rows) =>
    app.masterData.commands.applyPairExposureCurrencies({
      tenantId: opts.tenantId,
      sourceSystem: opts.sourceSystem,
      asOf: opts.asOf,
      mode: opts.mode,
      rows,
      by: opts.by,
      programCode: opts.programCode,
    }),
  );
}
