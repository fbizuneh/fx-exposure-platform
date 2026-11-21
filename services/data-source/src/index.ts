// Data Source's entry point for app/ to wire. Other services never import this; they import contract/.
import { connect, type Db } from "./db.ts";
import { intakeCommands } from "./intake.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";
import type { MasterDataQuestionsLike } from "./ports.ts";
import { dataSourceQuestions } from "./queries.ts";
import { ruleCommands } from "./rules.ts";

export function createDataSource(db: Db, deps: { masterData: MasterDataQuestionsLike; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    questions: dataSourceQuestions(db),
    commands: { ...intakeCommands(db, deps.masterData, now), ...ruleCommands(db, deps.masterData) },
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
export type { Db };
export { BatchRefused } from "./intake.ts";
export { RuleInvalid } from "./rules.ts";
export type { GlBatch, BatchResult } from "./intake.ts";
export type { ExpectedTotal } from "./control-totals.ts";
export type { GlBalanceRow, MappingRule, RuleKind, RuleTarget } from "./rows.ts";
export type { NewRule } from "./rules.ts";
export { parseGlFile, parseControlFile } from "./file.ts";
export type { FileProblem, ParseResult } from "./file.ts";
