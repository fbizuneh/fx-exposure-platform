// Exposure Management's entry point for app/ to wire. Other services never import this; they import contract/.
import type { TenantId } from "@shared/kernel";
import { cycleCommands } from "./cycles.ts";
import { connect, type Db } from "./db.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";
import { programCommands } from "./programs.ts";
import { exposureManagementQuestions } from "./queries.ts";
import type { IdentityPort } from "./access.ts";
import type { DecisionsPort } from "./ports.ts";
import { tenantCommands } from "./tenant.ts";

// The Identity questions are passed as `access`: the schema check reads "identity." in code as a table reference.
export function createExposureManagement(db: Db, deps: { access: IdentityPort; decisions: DecisionsPort; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    questions: exposureManagementQuestions(db),
    commands: { ...programCommands(db, deps.access), ...cycleCommands(db, deps.access, deps.decisions, now), ...tenantCommands(db, deps.access, now) },
    outbox: {
      pending: (limit?: number, now?: Date) => pendingEvents(db, limit, now),
      markPublished: (ids: readonly string[]) => markPublished(db, ids),
      recordFailure: (eventId: string, error: string, now: Date, policy: RetryPolicy) => recordFailure(db, eventId, error, now, policy),
      problems: () => deliveryProblems(db),
      retryStuck: (eventId: string, by: { tenantId: TenantId; actor: string }) => retryStuck(db, eventId, by),
    },
  };
}

export { connect };
export type { Db, IdentityPort, DecisionsPort };
export { AccessDenied } from "./access.ts";
export { CycleRefused } from "./cycles.ts";
export { ProgramRefused } from "./programs.ts";
export type { RunEvent } from "./cycles.ts";
export type { NewProgram, SettingsChange } from "./programs.ts";
