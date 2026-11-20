// Hedge Recommendation's entry point for app/ to wire. Other services never import this; they import contract/.
import { approvalCommands } from "./approval.ts";
import { connect, type Db } from "./db.ts";
import { decideCommands } from "./decide.ts";
import { generateCommands } from "./generate.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";
import { policyCommands } from "./policy.ts";
import { rollCommands } from "./roll.ts";
import type { Collaborators } from "./ports.ts";
import { hedgeRecommendationQuestions } from "./queries.ts";

export function createHedgeRecommendation(db: Db, collaborators: Collaborators, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    questions: hedgeRecommendationQuestions(db),
    commands: { ...generateCommands(db, collaborators, now), ...decideCommands(db, collaborators, now), ...approvalCommands(db, now), ...policyCommands(db, collaborators, now), ...rollCommands(db, collaborators, now) },
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
export type { Db, Collaborators };
export { AccessDenied } from "./access.ts";
export { RecommendationError } from "./decide.ts";
export type { Decision } from "./decide.ts";
export { PolicyInvalid } from "./policy.ts";
export { RollDatesInvalid } from "./roll.ts";
export type { RollDatesInput } from "./roll.ts";
export type { PolicyInput } from "./policy.ts";
export type { PreTradeRequest } from "./ports.ts";
