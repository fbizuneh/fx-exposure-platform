// Master Data's entry point for app/ to wire. Other services never import this; they import contract/.
import type { TenantId } from "@shared/kernel";
import { applyCommands } from "./apply.ts";
import { connect, type Db } from "./db.ts";
import { masterDataQuestions } from "./lookups.ts";
import { deliveryProblems, markPublished, pendingEvents, recordFailure, retryStuck, type RetryPolicy } from "./outbox.ts";

export function createMasterData(db: Db) {
  return {
    questions: masterDataQuestions(db),
    commands: applyCommands(db),
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
export { ChangeSetRefused } from "./apply.ts";
export type { SubmitResult } from "./apply.ts";
export { ChangeSetInvalid } from "./validate.ts";
export type { AccountRow, CalendarRow, CurrencyRow, EntityRow, HierarchyNodeRow, PairExposureCurrencyRow } from "./rows.ts";
export {
  parseAccountsFile,
  parseCalendarsFile,
  parseCurrenciesFile,
  parseEntitiesFile,
  parseExposureCurrenciesFile,
  parseHierarchyFile,
} from "./files.ts";
export type { FileProblem, ParseResult } from "./files.ts";
