// Published questions of Audit, and the change record every other service announces. Other services import this file, never src/.
import type { ProgramId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";

/**
 * What a service says about a change it made (decision 0012). Identifiers and field names only: the owning service holds the values.
 * `actor` is who did it, as the service knows them ("user:<id>", "platform:<id>"); `action` is a dotted name such as "cycle.approved".
 */
export interface ChangeRecordFields {
  readonly tenantId: TenantId;
  readonly programId: ProgramId | null;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** Names of the fields that changed; empty when the action is the whole change (an approval, a release). */
  readonly fields: readonly string[];
}

/** The announcement a service makes for each change record. The type is "<service>.change-recorded". */
export interface ChangeRecordedEvent extends ChangeRecordFields {
  readonly type: `${string}.change-recorded`;
  readonly eventId: string;
  readonly occurredAt: string;
}

export interface AuditRecord extends ChangeRecordFields {
  /** Position in the tenant's trail, from 1, in the order Audit received the records. */
  readonly seq: number;
  readonly recordId: string;
  /** The service that announced it. */
  readonly source: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly hash: string;
}

export interface TrailQuery {
  readonly tenantId: TenantId;
  readonly actor: Actor;
  readonly programId?: ProgramId;
  /** Who made the change, as recorded. */
  readonly by?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** Inclusive, ISO timestamps. */
  readonly from?: string;
  readonly to?: string;
  /** Records after this position, for paging. */
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface Trail {
  readonly records: readonly AuditRecord[];
  readonly nextAfterSeq: number | null;
}

export interface ChainCheck {
  readonly ok: boolean;
  readonly checked: number;
  /** The first position whose record or link does not match, when the chain is broken. */
  readonly brokenAtSeq: number | null;
}

export interface AuditQuestions {
  /** The tenant's trail, oldest first. Needs audit:read (in the program when one is asked for). */
  trail(query: TrailQuery): Promise<Trail>;
  /** Recomputes the tenant's hash chain. Needs audit:read. */
  verify(tenantId: TenantId, actor: Actor): Promise<ChainCheck>;
}
