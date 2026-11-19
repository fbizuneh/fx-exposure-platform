// Pure rules: settings, schedules and which program types may coexist. No I/O.
import { NETTING_LEVELS, NETTING_LEVEL_ALIASES, type BucketScheme, type NettingLevel, type ProgramType, type Schedule } from "../contract/index.ts";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const realDate = (v: string): boolean => ISO.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export interface SettingsInput {
  readonly nettingLevel: string;
  /** Defaults to USD when left out. */
  readonly displayCurrency?: string;
  readonly bucketScheme: BucketScheme;
  readonly schedule: Schedule | null;
}

/** The netting level a name stands for, accepting the names used before decision 0008; null when unknown. */
export function nettingLevelOf(name: string): NettingLevel | null {
  if ((NETTING_LEVELS as readonly string[]).includes(name)) return name as NettingLevel;
  return Object.hasOwn(NETTING_LEVEL_ALIASES, name) ? NETTING_LEVEL_ALIASES[name]! : null;
}

export const displayCurrencyOf = (s: SettingsInput): string => s.displayCurrency ?? "USD";

export function validateSettings(s: SettingsInput): string[] {
  const out: string[] = [];
  if (nettingLevelOf(s.nettingLevel) === null) out.push(`netting level must be one of ${NETTING_LEVELS.join(", ")}`);
  if (!/^[A-Z]{3}$/.test(displayCurrencyOf(s))) out.push("display currency must be a three-letter currency code in capitals");
  const b = s.bucketScheme as { kind?: string; boundaries?: unknown };
  if (b?.kind === "DAYS") {
    const edges = b.boundaries;
    if (!Array.isArray(edges) || edges.length === 0 || edges.length > 20) out.push("day buckets need 1 to 20 boundaries");
    else if (!edges.every((e) => Number.isInteger(e) && e >= 0 && e <= 3650)) out.push("day boundaries must be whole numbers from 0 to 3650");
    else if (!edges.every((e, i) => i === 0 || e > edges[i - 1])) out.push("day boundaries must be strictly ascending");
  } else if (b?.kind !== "MONTHS") out.push("bucket scheme must be DAYS or MONTHS");
  const sc = s.schedule as { frequency?: string; asOfOffsetDays?: unknown; dayOfWeek?: unknown; dayOfMonth?: unknown } | null;
  if (sc !== null) {
    if (!Number.isInteger(sc.asOfOffsetDays) || (sc.asOfOffsetDays as number) < 0 || (sc.asOfOffsetDays as number) > 31) out.push("as-of offset must be a whole number of days from 0 to 31");
    if (sc.frequency === "WEEKLY") {
      if (!Number.isInteger(sc.dayOfWeek) || (sc.dayOfWeek as number) < 1 || (sc.dayOfWeek as number) > 7) out.push("day of week must be 1 (Monday) to 7 (Sunday)");
    } else if (sc.frequency === "MONTHLY") {
      if (!Number.isInteger(sc.dayOfMonth) || (sc.dayOfMonth as number) < 1 || (sc.dayOfMonth as number) > 28) out.push("day of month must be 1 to 28");
    } else if (sc.frequency !== "DAILY") out.push("schedule frequency must be DAILY, WEEKLY or MONTHLY");
  }
  return out;
}

const CLASSIC: readonly ProgramType[] = ["BALANCE_SHEET", "CASH_FLOW", "IN_HOUSE_BANK"];

/** Why a new program cannot join the programs a tenant already has, or null when it can. */
export function combinationProblem(existing: readonly ProgramType[], adding: ProgramType): string | null {
  if (adding === "BALANCE_SHEET" && existing.includes("BALANCE_SHEET")) return "a tenant may run only one balance sheet program";
  if (adding === "BUDGET_TO_CASH" && existing.some((t) => CLASSIC.includes(t))) return "Budget to Cash cannot be combined with classic programs";
  if (CLASSIC.includes(adding) && existing.includes("BUDGET_TO_CASH")) return "classic programs cannot be combined with Budget to Cash";
  return null;
}

const addDays = (date: string, days: number): string => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

/** The as-of date a schedule asks for on `today`, or null when nothing is due today. */
export function scheduledAsOf(schedule: Schedule | null, today: string): string | null {
  if (schedule === null) return null;
  const d = new Date(`${today}T00:00:00Z`);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (schedule.frequency === "WEEKLY" && schedule.dayOfWeek !== weekday) return null;
  if (schedule.frequency === "MONTHLY" && schedule.dayOfMonth !== d.getUTCDate()) return null;
  return addDays(today, -schedule.asOfOffsetDays);
}
