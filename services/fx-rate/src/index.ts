// FX Rate's entry point for app/ to wire. Other services never import this; they import contract/.
import { connect, type Db } from "./db.ts";
import { loadCommands } from "./load.ts";
import { fxRateQuestions } from "./lookups.ts";
import { markPublished, pendingEvents } from "./outbox.ts";

export function createFxRate(db: Db, options: { now?: () => Date } = {}) {
  return {
    questions: fxRateQuestions(db),
    commands: loadCommands(db, options.now ?? (() => new Date())),
    outbox: { pending: (limit?: number) => pendingEvents(db, limit), markPublished: (ids: readonly string[]) => markPublished(db, ids) },
  };
}

export { connect };
export type { Db };
export { RatesInvalid } from "./validate.ts";
export type { RateRow } from "./rows.ts";
export type { RateLoad, LoadResult } from "./load.ts";
