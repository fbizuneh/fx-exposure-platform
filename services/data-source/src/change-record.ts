// Each change this service makes that matters to the audit trail is announced in the same transaction as the change (decision 0012).
import type { ChangeRecordFields } from "@services/audit/contract";
import type { Queryable } from "./db.ts";
import { announce } from "./outbox.ts";

export const recordChange = (tx: Queryable, c: ChangeRecordFields) => announce(tx, { type: "data-source.change-recorded", ...c });

/** Only changes made by a person go to the trail; a batch from a connector is a routine feed (decision 0012). A person is "user:<id>" or "platform:<id>". */
export const byPerson = (by: string): boolean => /^(user|platform):/.test(by);
