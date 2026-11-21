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
import type { LoadOutcome } from "./outcome.ts";

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

export async function loadEntitiesFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  const parsed = parseEntitiesFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyEntities({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export async function loadHierarchyFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  const parsed = parseHierarchyFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyHierarchy({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export async function loadAccountsFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  const parsed = parseAccountsFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyAccounts({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export async function loadCurrenciesFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  const parsed = parseCurrenciesFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyCurrencies({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export async function loadCalendarsFile(app: App, opts: MasterDataLoadOptions): Promise<LoadOutcome> {
  const parsed = parseCalendarsFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyCalendars({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

export async function loadExposureCurrenciesFile(app: App, opts: ExposureCurrencyLoadOptions): Promise<LoadOutcome> {
  const parsed = parseExposureCurrenciesFile(opts.text);
  if (parsed.problems.length > 0) return { kind: "INVALID_FILE", problems: parsed.problems };
  try {
    return fromSubmit(
      await app.masterData.commands.applyPairExposureCurrencies({
        tenantId: opts.tenantId,
        sourceSystem: opts.sourceSystem,
        asOf: opts.asOf,
        mode: opts.mode,
        rows: parsed.rows,
        by: opts.by,
        programCode: opts.programCode,
      }),
    );
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}
