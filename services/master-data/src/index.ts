// Master Data's entry point for app/ to wire. Other services never import this; they import contract/.
import { applyCommands } from "./apply.ts";
import { connect, type Db } from "./db.ts";
import { masterDataQuestions } from "./lookups.ts";
import { markPublished, pendingEvents } from "./outbox.ts";

export function createMasterData(db: Db) {
  return {
    questions: masterDataQuestions(db),
    commands: applyCommands(db),
    outbox: { pending: (limit?: number) => pendingEvents(db, limit), markPublished: (ids: readonly string[]) => markPublished(db, ids) },
  };
}

export { connect };
export type { Db };
export { ChangeSetRefused } from "./apply.ts";
export { ChangeSetInvalid } from "./validate.ts";
export type { AccountRow, CurrencyRow, EntityRow, HierarchyNodeRow } from "./rows.ts";
