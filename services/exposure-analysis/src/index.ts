// Exposure Analysis's entry point for app/ to wire. Other services never import this; they import contract/.
import { connect, type Db } from "./db.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";
import { exposureAnalysisQuestions } from "./queries.ts";
import { runCommands } from "./run.ts";

export function createExposureAnalysis(db: Db, deps: Collaborators & { now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    questions: exposureAnalysisQuestions(db),
    commands: runCommands(db, deps, now),
    outbox: {
      pending: (limit?: number, now?: Date) => pendingEvents(db, limit, now),
      markPublished: (ids: readonly string[]) => markPublished(db, ids),
      recordFailure: (eventId: string, error: string, now: Date, policy: RetryPolicy) => recordFailure(db, eventId, error, now, policy),
      problems: () => deliveryProblems(db),
      retryStuck: (eventId: string) => retryStuck(db, eventId),
    },
  };
}

export { connect };
export type { Collaborators, Db };
export type { CycleApprovedEvent, CycleInitiatedEvent, RunOutcome } from "./run.ts";
