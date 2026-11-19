// FX Trade's entry point for app/ to wire. Other services never import this; they import contract/.
import { connect, type Db } from "./db.ts";
import { importCommands } from "./import.ts";
import { fxTradeQuestions } from "./lookups.ts";
import { markPublished, pendingEvents } from "./outbox.ts";
import { preTradeCommands } from "./pretrades.ts";
import type { Collaborators } from "./ports.ts";

export function createFxTrade(db: Db, collaborators: Collaborators, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    questions: fxTradeQuestions(db),
    commands: { ...preTradeCommands(db, collaborators, now), ...importCommands(db, collaborators) },
    outbox: { pending: (limit?: number) => pendingEvents(db, limit), markPublished: (ids: readonly string[]) => markPublished(db, ids) },
  };
}

export { connect };
export type { Db, Collaborators };
export { AccessDenied } from "./access.ts";
export { PreTradeInvalid } from "./pretrades.ts";
export { parseExecutedFile, toPreTradeFile } from "./file.ts";
export type { ExecutedRow } from "./file.ts";
export type { ImportResult } from "./import.ts";
export type { NewPreTradeBody, RecommendedPreTrade, Created } from "./pretrades.ts";
