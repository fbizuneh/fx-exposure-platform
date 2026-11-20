// Each change this service makes that matters to the audit trail is announced in the same transaction as the change (decision 0012).
import type { ChangeRecordFields } from "@services/audit/contract";
import type { Queryable } from "./db.ts";
import { announce } from "./outbox.ts";

export const recordChange = (tx: Queryable, c: ChangeRecordFields) => announce(tx, { type: "exposure-management.change-recorded", ...c });
