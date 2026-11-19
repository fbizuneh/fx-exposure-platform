// The seven identifiers that cross every service boundary. Nothing else is shared.
// Each is defined by one service; everyone else only carries it (docs/design).

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">; // defined by Identity
export type ProgramId = Brand<string, "ProgramId">; // the program code, defined by Exposure Management
export type CycleId = Brand<string, "CycleId">; // defined by Exposure Management
export type AsOfDate = Brand<string, "AsOfDate">; // ISO date from the source system, never the processing date
export type EntityId = Brand<string, "EntityId">; // defined by Master Data
export type AccountId = Brand<string, "AccountId">; // defined by Master Data

/** Source system, batch and record, defined by Data Source. */
export interface LineageRef {
  readonly sourceSystem: string;
  readonly batchId: string;
  readonly recordId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty string without surrounding spaces`);
  }
  return value;
}

function uuid(name: string, value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

export const tenantId = (v: string): TenantId => uuid("tenantId", v) as TenantId;
export const cycleId = (v: string): CycleId => uuid("cycleId", v) as CycleId;
export const programId = (v: string): ProgramId => nonEmpty("programId", v) as ProgramId;
export const entityId = (v: string): EntityId => nonEmpty("entityId", v) as EntityId;
export const accountId = (v: string): AccountId => nonEmpty("accountId", v) as AccountId;

/** Accepts only a real calendar date written YYYY-MM-DD. */
export function asOfDate(v: string): AsOfDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === "string" ? v : "");
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) {
      return v as AsOfDate;
    }
  }
  throw new TypeError("asOfDate must be a real date written YYYY-MM-DD");
}

export function lineageRef(sourceSystem: string, batchId: string, recordId: string): LineageRef {
  return {
    sourceSystem: nonEmpty("sourceSystem", sourceSystem),
    batchId: nonEmpty("batchId", batchId),
    recordId: nonEmpty("recordId", recordId),
  };
}
