// The hash chain: each record's hash covers its content and the hash before it, so changing or removing a record breaks every link after it.
import { createHash } from "node:crypto";

export const GENESIS = "GENESIS";

export interface Hashed {
  readonly tenantId: string; readonly seq: number; readonly recordId: string; readonly source: string; readonly programId: string | null;
  readonly actor: string; readonly action: string; readonly targetType: string; readonly targetId: string; readonly fields: readonly string[];
  /** When the change happened (set by the announcing service) and when Audit received it (set once, when appended). Both are covered. */
  readonly occurredAt: string; readonly recordedAt: string;
}

export function hashOf(prev: string, r: Hashed): string {
  const body = JSON.stringify([prev, r.tenantId, r.seq, r.recordId, r.source, r.programId, r.actor, r.action, r.targetType, r.targetId, r.fields, r.occurredAt, r.recordedAt]);
  return createHash("sha256").update(body).digest("hex");
}
