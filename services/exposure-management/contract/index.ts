// Published questions and events of Exposure Management. Other services import this file, never src/.
import type { AsOfDate, CycleId, ProgramId, TenantId } from "@shared/kernel";

export const PROGRAM_TYPES = ["BALANCE_SHEET", "CASH_FLOW", "BUDGET_TO_CASH", "IN_HOUSE_BANK"] as const;
export type ProgramType = (typeof PROGRAM_TYPES)[number];

/**
 * Where exposure is netted, always by currency pair and period (decision 0008).
 * GROUP_NATURAL: whole group, natural pairs. GROUP_PORTFOLIO: whole group, every pair re-expressed against the display currency.
 * REGION: by region. REGION_BY_ENTITY: by region and legal entity. ENTITY: by legal entity.
 */
export const NETTING_LEVELS = ["GROUP_NATURAL", "GROUP_PORTFOLIO", "REGION", "REGION_BY_ENTITY", "ENTITY"] as const;
export type NettingLevel = (typeof NETTING_LEVELS)[number];
/** Names used before decision 0008. They are accepted on input and stored as the level they map to. */
export const NETTING_LEVEL_ALIASES: Readonly<Record<string, NettingLevel>> = {
  ENTITY_PAIR: "ENTITY", CORPORATE_PAIR: "GROUP_NATURAL", REGION_PAIR: "REGION",
};

/**
 * How exposure is split into date buckets. DAYS: the upper edges, in days after the as-of date, strictly
 * ascending (for example 0, 30, 90), with one open bucket beyond the last. MONTHS: calendar months.
 */
export type BucketScheme = { readonly kind: "DAYS"; readonly boundaries: readonly number[] } | { readonly kind: "MONTHS" };

/** When a cycle starts by itself. The as-of date is the run date minus the offset. Dates are UTC. */
export type Schedule =
  | { readonly frequency: "DAILY"; readonly asOfOffsetDays: number }
  | { readonly frequency: "WEEKLY"; readonly dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7; readonly asOfOffsetDays: number }
  | { readonly frequency: "MONTHLY"; readonly dayOfMonth: number; readonly asOfOffsetDays: number };

export interface ProgramSummary {
  readonly programId: ProgramId;
  readonly name: string;
  readonly type: ProgramType;
  /** Follows Identity: a disabled program cannot start cycles. */
  readonly enabled: boolean;
}

/** The settings in force on a date. */
export interface ProgramSettings {
  readonly programId: ProgramId;
  readonly type: ProgramType;
  readonly nettingLevel: NettingLevel;
  /** The currency gross and net exposure are also shown in; also the portfolio currency for GROUP_PORTFOLIO. Default USD. */
  readonly displayCurrency: string;
  readonly bucketScheme: BucketScheme;
  readonly schedule: Schedule | null;
  /** The first day this version applies. */
  readonly validFrom: AsOfDate;
}

export const CYCLE_STAGES = ["INITIATED", "IN_PROGRESS", "COMPLETED"] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];
export type CycleOutcome = "SKIPPED" | "DELETED";

export interface CycleHistoryEntry {
  readonly kind: "INITIATED" | "RUN_STARTED" | "RUN_FINISHED" | "RERUN" | "SKIPPED" | "DELETED" | "APPROVED";
  /** "user:<id>" or "platform:<id>"; null when the step came from another service. */
  readonly by: string | null;
  readonly at: string;
  readonly note: string | null;
}

export interface CycleSummary {
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
  readonly stage: CycleStage;
  /** Set when the cycle was skipped or deleted. Such a cycle is closed. */
  readonly outcome: CycleOutcome | null;
  readonly outcomeReason: string | null;
  readonly rerunCount: number;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
}

export interface Cycle extends CycleSummary {
  /** The settings in force on the as-of date when the cycle started. They do not change afterwards. */
  readonly settings: ProgramSettings;
  readonly history: readonly CycleHistoryEntry[];
}

export interface DueCycle {
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
}

export interface ExposureManagementQuestions {
  programCatalog(tenantId: TenantId): Promise<readonly ProgramSummary[]>;
  /** Null when the program is unknown or has no settings in force on that date. */
  programSettings(tenantId: TenantId, programId: ProgramId, asOf: AsOfDate): Promise<ProgramSettings | null>;
  getCycle(tenantId: TenantId, cycleId: CycleId): Promise<Cycle | null>;
  cycles(
    tenantId: TenantId,
    filter?: { readonly programId?: ProgramId; readonly open?: boolean; readonly limit?: number },
  ): Promise<readonly CycleSummary[]>;
  /** The cycles the schedule says should start on `today`: enabled programs with no cycle for that as-of date and no open cycle. */
  dueCycles(tenantId: TenantId, today: AsOfDate): Promise<readonly DueCycle[]>;
}

interface Announcement {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}
/** A cycle started, or was rerun. Exposure Analysis collects and runs on this. */
export interface CycleInitiated extends Announcement {
  readonly type: "exposure-management.cycle-initiated";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
  readonly asOf: AsOfDate;
}
export interface CycleCompleted extends Announcement {
  readonly type: "exposure-management.cycle-completed";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
}
/** Each service freezes its part under the cycle ID on this. */
export interface CycleApproved extends Announcement {
  readonly type: "exposure-management.cycle-approved";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
}
export interface CycleSkipped extends Announcement {
  readonly type: "exposure-management.cycle-skipped";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
}
export interface CycleDeleted extends Announcement {
  readonly type: "exposure-management.cycle-deleted";
  readonly cycleId: CycleId;
  readonly programId: ProgramId;
}
/** A program was defined or its settings changed. */
export interface ProgramChanged extends Announcement {
  readonly type: "exposure-management.program-changed";
  readonly programId: ProgramId;
}
export type ExposureManagementEvents = CycleInitiated | CycleCompleted | CycleApproved | CycleSkipped | CycleDeleted | ProgramChanged;
