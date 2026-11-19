// Identity's entry point for app/ to wire. Other services never import this; they import contract/.
import type { IdentityQuestions } from "../contract/index.ts";
import { decide } from "./access.ts";
import { identityCommands } from "./commands.ts";
import { connect, type Db } from "./db.ts";
import { loadAccessFacts, loadEnabledPrograms } from "./facts.ts";
import { markPublished, pendingEvents } from "./outbox.ts";

export function identityQuestions(db: Db): IdentityQuestions {
  return {
    async checkAccess(query) {
      return decide(query, await loadAccessFacts(db, query));
    },
    async enabledPrograms(tenant) {
      return loadEnabledPrograms(db, tenant);
    },
  };
}

export function createIdentity(db: Db) {
  return {
    questions: identityQuestions(db),
    commands: identityCommands(db),
    outbox: { pending: (limit?: number) => pendingEvents(db, limit), markPublished: (ids: readonly string[]) => markPublished(db, ids) },
  };
}

export { connect };
export type { Db };
