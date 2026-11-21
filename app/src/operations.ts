// Guarded access to the stuck-event functions in dispatch.ts: who may see and retry a tenant's delivery problems (decision 0030).
// dispatch.ts itself checks nothing; this is the only path a caller outside app/ should use.
import { randomUUID } from "node:crypto";
import type { Actor, DenyReason } from "@services/identity/contract";
import type { TenantId } from "@shared/kernel";
import type { App } from "./compose.ts";
import { deliveryProblems, retryStuckEvent, type DeliveryProblem } from "./dispatch.ts";

const PERMISSION = "operations:manage-events" as const;

export class AccessDenied extends Error {
  readonly reason: DenyReason;
  constructor(reason: DenyReason) {
    super(`not allowed (${PERMISSION}): ${reason}`);
    this.reason = reason;
  }
}

async function checkTenant(app: App, actor: Actor, tenant: TenantId): Promise<void> {
  const decision = await app.identity.questions.checkAccess({ tenantId: tenant, actor, permission: PERMISSION });
  if (!decision.allowed) throw new AccessDenied(decision.reason);
}

/** The tenants whose events this actor may see: the admin's own tenant, or, for the platform role, every tenant (decision #8/0030). */
async function visibleTenants(app: App, actor: Actor, candidates: Iterable<string>): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const t of new Set(candidates)) {
    const decision = await app.identity.questions.checkAccess({ tenantId: t as TenantId, actor, permission: PERMISSION });
    if (decision.allowed) visible.add(t);
  }
  return visible;
}

/** Every real tenant plus any tenant that currently has a delivery problem, so an admin of a trouble-free tenant is still recognised. */
async function candidateTenants(app: App, problems: readonly DeliveryProblem[]): Promise<Set<string>> {
  const active = await app.identity.questions.activeTenants();
  return new Set<string>([...active, ...problems.map((p) => p.tenantId)]);
}

const trimmed = (p: DeliveryProblem): DeliveryProblem => ({ ...p, lastError: p.lastError === null ? null : p.lastError.slice(0, 500) });

/**
 * Service, tenant, event ID, event type, tries, last error (cut to 500 characters) and next-try or stuck time.
 * A tenant admin sees only their tenant's events; the platform role sees every tenant's, and may narrow with `filter.tenantId`.
 */
export async function listDeliveryProblems(app: App, actor: Actor, filter?: { readonly tenantId?: TenantId }): Promise<DeliveryProblem[]> {
  const all = await deliveryProblems(app);
  if (filter?.tenantId !== undefined) {
    await checkTenant(app, actor, filter.tenantId);
    return all.filter((p) => p.tenantId === filter.tenantId).map(trimmed);
  }
  const visible = await visibleTenants(app, actor, await candidateTenants(app, all));
  if (visible.size === 0) throw new AccessDenied("permission-missing");
  return all.filter((p) => visible.has(p.tenantId)).map(trimmed);
}

export interface DeliveryProblemSummary {
  readonly byService: Readonly<Record<string, { readonly waiting: number; readonly stuck: number }>>;
  readonly total: { readonly waiting: number; readonly stuck: number };
}

/** Counts by service and by state (waiting, stuck), over whatever tenants this actor may see. For a badge, or the runtime's /status. */
export async function deliveryProblemSummary(app: App, actor: Actor): Promise<DeliveryProblemSummary> {
  const all = await deliveryProblems(app);
  const visible = await visibleTenants(app, actor, await candidateTenants(app, all));
  if (visible.size === 0) throw new AccessDenied("permission-missing");
  const byService: Record<string, { waiting: number; stuck: number }> = {};
  const total = { waiting: 0, stuck: 0 };
  for (const p of all) {
    if (!visible.has(p.tenantId)) continue;
    const bucket = (byService[p.service] ??= { waiting: 0, stuck: 0 });
    if (p.stuckAt !== null) {
      bucket.stuck++;
      total.stuck++;
    } else {
      bucket.waiting++;
      total.waiting++;
    }
  }
  return { byService, total };
}

export interface RetryTarget {
  readonly service: string;
  readonly tenantId: TenantId;
  readonly eventId: string;
}

/**
 * Retries a stuck event, after checking access for its named tenant and looking the event up within that tenant only — so one
 * tenant's admin can never reach another tenant's event by guessing an ID. Refuses an event that is not stuck, naming its state.
 * The retry itself is recorded to Audit as `event.retried` (decision 0030); `checkAccess` already records a platform role's use.
 * KNOWN GAP (DECISION REQUIRED, decision 0030): this record is written after the reset below has already committed, not in the
 * same transaction, so it can be lost to a crash or an Audit outage between the two steps, with the event then no longer stuck
 * and so never retried through this path again. The durable fix (each service's own outbox announces the retry, in the same
 * transaction as the reset) touches every service's outbox.ts and awaits the product owner's confirmation.
 */
export async function retryDeliveryProblem(app: App, actor: Actor, target: RetryTarget): Promise<void> {
  await checkTenant(app, actor, target.tenantId);
  const found = (await deliveryProblems(app)).find((p) => p.service === target.service && p.tenantId === target.tenantId && p.eventId === target.eventId);
  if (!found) throw new RangeError("no such event for this tenant");
  if (found.stuckAt === null) throw new RangeError("the event is retrying automatically; it is not stuck");
  const retried = await retryStuckEvent(app, target.service, target.eventId);
  if (!retried) throw new RangeError("the event is no longer stuck");
  const by = actor.kind === "user" ? `user:${actor.userId}` : `platform:${actor.platformUserId}`;
  await app.audit.commands.record({
    type: "operations.change-recorded", eventId: randomUUID(), occurredAt: new Date().toISOString(), tenantId: target.tenantId, programId: null,
    actor: by, action: "event.retried", targetType: target.service, targetId: target.eventId, fields: [],
  });
}
