// FX Rate's entry point for app/ to wire. Other services never import this; they import contract/.
import type { TenantId } from "@shared/kernel";
import { connect, type Db } from "./db.ts";
import { loadCommands } from "./load.ts";
import { fxRateQuestions } from "./lookups.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";

export function createFxRate(db: Db, options: { now?: () => Date } = {}) {
  return {
    questions: fxRateQuestions(db),
    commands: loadCommands(db, options.now ?? (() => new Date())),
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
export type { Db };
export { RatesInvalid } from "./validate.ts";
export type { RateRow } from "./rows.ts";
export type { RateLoad, LoadResult } from "./load.ts";
export { parseRatesFile } from "./file.ts";
export type { FileProblem, ParseResult } from "./file.ts";
