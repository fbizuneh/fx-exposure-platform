// Audit's entry point for app/ to wire. Other services never import this; they import contract/.
import { connect, type Db } from "./db.ts";
import type { IdentityPort } from "./access.ts";
import { auditQuestions } from "./queries.ts";
import { recordCommands } from "./record.ts";

export function createAudit(db: Db, collaborators: { access: IdentityPort }, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return { questions: auditQuestions(db, collaborators.access), commands: recordCommands(db, now) };
}

export { connect };
export type { Db };
export { AccessDenied } from "./access.ts";
export { RecordInvalid } from "./record.ts";
