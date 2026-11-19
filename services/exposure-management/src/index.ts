// Exposure Management's entry point for app/ to wire. Other services never import this; they import contract/.
import { cycleCommands } from "./cycles.ts";
import { connect, type Db } from "./db.ts";
import { markPublished, pendingEvents } from "./outbox.ts";
import { programCommands } from "./programs.ts";
import { exposureManagementQuestions } from "./queries.ts";
import type { IdentityPort } from "./access.ts";

// The Identity questions are passed as `access`: the schema check reads "identity." in code as a table reference.
export function createExposureManagement(db: Db, deps: { access: IdentityPort; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    questions: exposureManagementQuestions(db),
    commands: { ...programCommands(db, deps.access), ...cycleCommands(db, deps.access, now) },
    outbox: { pending: (limit?: number) => pendingEvents(db, limit), markPublished: (ids: readonly string[]) => markPublished(db, ids) },
  };
}

export { connect };
export type { Db, IdentityPort };
export { AccessDenied } from "./access.ts";
export { CycleRefused } from "./cycles.ts";
export { ProgramRefused } from "./programs.ts";
export type { RunEvent } from "./cycles.ts";
export type { NewProgram, SettingsChange } from "./programs.ts";
