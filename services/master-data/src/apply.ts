// The one write path (docs/decisions/0004): a change set, one kind at a time, applied in one transaction
// together with its event. A snapshot that would end too much is held until someone releases or rejects it.
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { AsOfDate, TenantId } from "@shared/kernel";
import { q, type Db, type Tx } from "./db.ts";
import { DEFAULT_MAX_END_SHARE, plan, shouldHold, stable, type OpenRow, type Plan } from "./diff.ts";
import { byPerson, recordChange } from "./change-record.ts";
import { announce } from "./outbox.ts";
import { chartKey, type AccountRow, type CalendarRow, type CurrencyRow, type EntityRow, type HierarchyNodeRow, type Kind, type Mode } from "./rows.ts";
import { WEEKDAYS } from "../contract/index.ts";
import { ChangeSetInvalid, validateAccounts, validateCalendars, validateCurrencies, validateEntities, validateHierarchy } from "./validate.ts";

/** The change set cannot be applied as things stand: out of date, a repeat with other content, or not held. */
export class ChangeSetRefused extends Error {}

export interface Submission<R> {
  readonly tenantId: TenantId;
  readonly sourceSystem: string;
  readonly asOf: AsOfDate;
  readonly mode: Mode;
  readonly rows: readonly R[];
  /** Who or what sent it: a user id, a platform user id or a connector name. */
  readonly by: string;
}

export interface SubmitResult {
  readonly status: "APPLIED" | "HELD" | "DUPLICATE";
  readonly batchId: string;
  readonly created: number;
  readonly changed: number;
  readonly ended: number;
  readonly unchanged: number;
  readonly heldReason?: string;
}

interface Loaded {
  open: Map<string, OpenRow>;
  ids: Map<string, string>;
  maxValidFrom: string | null;
  openParents: Map<string, string | null>;
  openNodeKeys: Set<string>;
  nodeIdByKey: Map<string, string>;
  charts: Map<string, string>;
}

interface WriteCtx<R> {
  tenant: TenantId;
  asOf: string;
  source: string;
  batchId: string;
  rows: Map<string, R>;
  plan: Plan;
  loaded: Loaded;
}

interface Ops<R> {
  kind: Kind;
  keyOf(r: R): string;
  attrsOf(r: R): object;
  load(tx: Tx, tenant: TenantId, asOf: string): Promise<Loaded>;
  validate(rows: readonly R[], l: Loaded, mode: Mode): string[];
  write(tx: Tx, w: WriteCtx<R>): Promise<void>;
}

type Version = { valid_from: string; valid_to: string | null };
const isOpen = (r: Version, asOf: string) => r.valid_from <= asOf && (r.valid_to === null || r.valid_to > asOf);
const emptyLoaded = (): Loaded => ({
  open: new Map(), ids: new Map(), maxValidFrom: null, openParents: new Map(), openNodeKeys: new Set(), nodeIdByKey: new Map(), charts: new Map(),
});
const later = (a: string | null, b: string) => (a === null || b > a ? b : a);

async function loadCharts(tx: Tx, tenant: TenantId): Promise<{ byCode: Map<string, string>; codeById: Map<string, string> }> {
  const rows = await q(tx).selectFrom("charts_of_accounts").select(["chart_id", "code"]).where("tenant_id", "=", tenant).execute();
  return { byCode: new Map(rows.map((r) => [r.code, r.chart_id])), codeById: new Map(rows.map((r) => [r.chart_id, r.code])) };
}

async function ensureCharts(tx: Tx, tenant: TenantId, codes: Iterable<string>, have: Map<string, string>): Promise<void> {
  for (const code of new Set(codes)) {
    if (have.has(code)) continue;
    const row = await q(tx).insertInto("charts_of_accounts").values({ tenant_id: tenant, code, name: code }).returning("chart_id").executeTakeFirstOrThrow();
    have.set(code, row.chart_id);
  }
}

async function closeVersion(tx: Tx, table: "entities" | "gl_hierarchy_nodes" | "accounts" | "currencies" | "calendars", idCol: string, tenant: string, id: string, validFrom: string, asOf: string) {
  const db = q(tx) as unknown as Kysely<any>;
  if (validFrom === asOf) {
    // A version that starts the same day is replaced in place, so no empty range is ever stored.
    await db.deleteFrom(table).where("tenant_id", "=", tenant).where(idCol, "=", id).where("valid_from", "=", validFrom).execute();
  } else {
    await db.updateTable(table).set({ valid_to: asOf }).where("tenant_id", "=", tenant).where(idCol, "=", id).where("valid_from", "=", validFrom).execute();
  }
}

const entityOps: Ops<EntityRow> = {
  kind: "ENTITY",
  keyOf: (r) => r.code,
  attrsOf: (r) => ({
    name: r.name, type: r.type, parentCode: r.parentCode, countryCode: r.countryCode, functionalCurrency: r.functionalCurrency,
    isLegalEntity: r.isLegalEntity, isTreasuryEntity: r.isTreasuryEntity, isHedgeExecutionEntity: r.isHedgeExecutionEntity,
  }),
  async load(tx, tenant, asOf) {
    const l = emptyLoaded();
    const rows = (await q(tx).selectFrom("entities").selectAll().where("tenant_id", "=", tenant).orderBy("valid_from").execute());
    const open = rows.filter((r) => isOpen(r, asOf));
    const codeById = new Map(open.map((r) => [r.entity_id, r.code]));
    for (const r of rows) {
      l.ids.set(r.code, r.entity_id);
      l.maxValidFrom = later(l.maxValidFrom, r.valid_from);
    }
    for (const r of open) {
      const parentCode = r.parent_entity_id ? (codeById.get(r.parent_entity_id) ?? null) : null;
      l.openParents.set(r.code, parentCode);
      l.open.set(r.code, {
        id: r.entity_id, validFrom: r.valid_from, source: r.source_system,
        attrs: stable({
          name: r.name, type: r.entity_type, parentCode, countryCode: r.country_code, functionalCurrency: r.functional_currency,
          isLegalEntity: r.is_legal_entity, isTreasuryEntity: r.is_treasury_entity, isHedgeExecutionEntity: r.is_hedge_execution_entity,
        }),
      });
    }
    return l;
  },
  validate: (rows, l, mode) => validateEntities(rows, l.openParents, mode),
  async write(tx, w) {
    const ids = new Map(w.loaded.ids);
    for (const k of w.plan.creates) if (!ids.has(k)) ids.set(k, randomUUID());
    for (const k of [...w.plan.changes, ...w.plan.ends]) {
      const cur = w.loaded.open.get(k)!;
      await closeVersion(tx, "entities", "entity_id", w.tenant, cur.id, cur.validFrom, w.asOf);
    }
    for (const k of [...w.plan.creates, ...w.plan.changes]) {
      const r = w.rows.get(k)!;
      await q(tx).insertInto("entities").values({
        tenant_id: w.tenant, entity_id: ids.get(k)!, valid_from: w.asOf, valid_to: null, source_system: w.source, batch_id: w.batchId,
        code: r.code, name: r.name, entity_type: r.type, parent_entity_id: r.parentCode === null ? null : (ids.get(r.parentCode) ?? null),
        country_code: r.countryCode, functional_currency: r.functionalCurrency,
        is_legal_entity: r.isLegalEntity, is_treasury_entity: r.isTreasuryEntity, is_hedge_execution_entity: r.isHedgeExecutionEntity,
      }).execute();
    }
  },
};

const hierarchyOps: Ops<HierarchyNodeRow> = {
  kind: "HIERARCHY",
  keyOf: (r) => chartKey(r.chartCode, r.code),
  attrsOf: (r) => ({ name: r.name, classification: r.classification, parentCode: r.parentCode }),
  async load(tx, tenant, asOf) {
    const l = emptyLoaded();
    const charts = await loadCharts(tx, tenant);
    l.charts = charts.byCode;
    const rows = await q(tx).selectFrom("gl_hierarchy_nodes").selectAll().where("tenant_id", "=", tenant).orderBy("valid_from").execute();
    const open = rows.filter((r) => isOpen(r, asOf));
    const codeById = new Map(open.map((r) => [r.node_id, r.code]));
    for (const r of rows) {
      l.ids.set(chartKey(charts.codeById.get(r.chart_id)!, r.code), r.node_id);
      l.maxValidFrom = later(l.maxValidFrom, r.valid_from);
    }
    for (const r of open) {
      const chart = charts.codeById.get(r.chart_id)!;
      const key = chartKey(chart, r.code);
      const parentCode = r.parent_node_id ? (codeById.get(r.parent_node_id) ?? null) : null;
      l.openParents.set(key, parentCode === null ? null : chartKey(chart, parentCode));
      l.open.set(key, { id: r.node_id, validFrom: r.valid_from, source: r.source_system, attrs: stable({ name: r.name, classification: r.classification, parentCode }) });
    }
    return l;
  },
  validate: (rows, l, mode) => validateHierarchy(rows, l.openParents, mode),
  async write(tx, w) {
    const ids = new Map(w.loaded.ids);
    for (const k of w.plan.creates) if (!ids.has(k)) ids.set(k, randomUUID());
    const charts = new Map(w.loaded.charts);
    await ensureCharts(tx, w.tenant, [...w.rows.values()].map((r) => r.chartCode), charts);
    for (const k of [...w.plan.changes, ...w.plan.ends]) {
      const cur = w.loaded.open.get(k)!;
      await closeVersion(tx, "gl_hierarchy_nodes", "node_id", w.tenant, cur.id, cur.validFrom, w.asOf);
    }
    for (const k of [...w.plan.creates, ...w.plan.changes]) {
      const r = w.rows.get(k)!;
      await q(tx).insertInto("gl_hierarchy_nodes").values({
        tenant_id: w.tenant, node_id: ids.get(k)!, valid_from: w.asOf, valid_to: null, source_system: w.source, batch_id: w.batchId,
        chart_id: charts.get(r.chartCode)!, code: r.code, name: r.name, classification: r.classification,
        parent_node_id: r.parentCode === null ? null : (ids.get(chartKey(r.chartCode, r.parentCode)) ?? null),
      }).execute();
    }
  },
};

const accountOps: Ops<AccountRow> = {
  kind: "ACCOUNT",
  keyOf: (r) => chartKey(r.chartCode, r.accountNumber),
  attrsOf: (r) => ({
    name: r.name, statementType: r.statementType, normalBalance: r.normalBalance, monetaryFlag: r.monetaryFlag,
    fxRelevantFlag: r.fxRelevantFlag, hierarchyNodeCode: r.hierarchyNodeCode,
  }),
  async load(tx, tenant, asOf) {
    const l = emptyLoaded();
    const charts = await loadCharts(tx, tenant);
    l.charts = charts.byCode;
    const nodes = (await q(tx).selectFrom("gl_hierarchy_nodes").selectAll().where("tenant_id", "=", tenant).execute()).filter((n) => isOpen(n, asOf));
    const nodeCodeById = new Map(nodes.map((n) => [n.node_id, n.code]));
    for (const n of nodes) {
      const key = chartKey(charts.codeById.get(n.chart_id)!, n.code);
      l.openNodeKeys.add(key);
      l.nodeIdByKey.set(key, n.node_id);
    }
    const rows = await q(tx).selectFrom("accounts").selectAll().where("tenant_id", "=", tenant).orderBy("valid_from").execute();
    for (const r of rows) {
      l.ids.set(chartKey(charts.codeById.get(r.chart_id)!, r.account_number), r.account_id);
      l.maxValidFrom = later(l.maxValidFrom, r.valid_from);
      if (!isOpen(r, asOf)) continue;
      l.open.set(chartKey(charts.codeById.get(r.chart_id)!, r.account_number), {
        id: r.account_id, validFrom: r.valid_from, source: r.source_system,
        attrs: stable({
          name: r.name, statementType: r.statement_type, normalBalance: r.normal_balance, monetaryFlag: r.monetary_flag,
          fxRelevantFlag: r.fx_relevant_flag, hierarchyNodeCode: r.hierarchy_node_id ? (nodeCodeById.get(r.hierarchy_node_id) ?? null) : null,
        }),
      });
    }
    return l;
  },
  validate: (rows, l) => validateAccounts(rows, l.openNodeKeys),
  async write(tx, w) {
    const ids = new Map(w.loaded.ids);
    for (const k of w.plan.creates) if (!ids.has(k)) ids.set(k, randomUUID());
    const charts = new Map(w.loaded.charts);
    await ensureCharts(tx, w.tenant, [...w.rows.values()].map((r) => r.chartCode), charts);
    for (const k of [...w.plan.changes, ...w.plan.ends]) {
      const cur = w.loaded.open.get(k)!;
      await closeVersion(tx, "accounts", "account_id", w.tenant, cur.id, cur.validFrom, w.asOf);
    }
    for (const k of [...w.plan.creates, ...w.plan.changes]) {
      const r = w.rows.get(k)!;
      await q(tx).insertInto("accounts").values({
        tenant_id: w.tenant, account_id: ids.get(k)!, valid_from: w.asOf, valid_to: null, source_system: w.source, batch_id: w.batchId,
        chart_id: charts.get(r.chartCode)!, account_number: r.accountNumber, name: r.name,
        hierarchy_node_id: r.hierarchyNodeCode === null ? null : (w.loaded.nodeIdByKey.get(chartKey(r.chartCode, r.hierarchyNodeCode)) ?? null),
        statement_type: r.statementType, normal_balance: r.normalBalance, monetary_flag: r.monetaryFlag, fx_relevant_flag: r.fxRelevantFlag,
      }).execute();
    }
  },
};

const currencyOps: Ops<CurrencyRow> = {
  kind: "CURRENCY",
  keyOf: (r) => r.code,
  attrsOf: (r) => ({ isNdf: r.isNdf }),
  async load(tx, tenant, asOf) {
    const l = emptyLoaded();
    const rows = await q(tx).selectFrom("currencies").selectAll().where("tenant_id", "=", tenant).orderBy("valid_from").execute();
    for (const r of rows) {
      l.ids.set(r.code, r.currency_id);
      l.maxValidFrom = later(l.maxValidFrom, r.valid_from);
      if (isOpen(r, asOf)) l.open.set(r.code, { id: r.currency_id, validFrom: r.valid_from, source: r.source_system, attrs: stable({ isNdf: r.is_ndf }) });
    }
    return l;
  },
  validate: (rows) => validateCurrencies(rows),
  async write(tx, w) {
    const ids = new Map(w.loaded.ids);
    for (const k of w.plan.creates) if (!ids.has(k)) ids.set(k, randomUUID());
    for (const k of [...w.plan.changes, ...w.plan.ends]) {
      const cur = w.loaded.open.get(k)!;
      await closeVersion(tx, "currencies", "currency_id", w.tenant, cur.id, cur.validFrom, w.asOf);
    }
    for (const k of [...w.plan.creates, ...w.plan.changes]) {
      const r = w.rows.get(k)!;
      await q(tx).insertInto("currencies").values({
        tenant_id: w.tenant, currency_id: ids.get(k)!, valid_from: w.asOf, valid_to: null, source_system: w.source, batch_id: w.batchId, code: r.code, is_ndf: r.isNdf,
      }).execute();
    }
  },
};

/** Weekend days in the week's order and holidays by date, so the same calendar sent in another order is not a change. */
const calendarAttrs = (weekend: readonly string[], coveredThrough: string, holidays: readonly { date: string; name: string | null }[]) => ({
  weekendDays: [...weekend].sort((a, b) => WEEKDAYS.indexOf(a as never) - WEEKDAYS.indexOf(b as never)),
  coveredThrough,
  holidays: [...holidays].map((h) => ({ date: h.date, name: h.name })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
});

const calendarOps: Ops<CalendarRow> = {
  kind: "CALENDAR",
  keyOf: (r) => r.currencyCode,
  attrsOf: (r) => calendarAttrs(r.weekendDays, r.coveredThrough, r.holidays),
  async load(tx, tenant, asOf) {
    const l = emptyLoaded();
    const rows = await q(tx).selectFrom("calendars").selectAll().where("tenant_id", "=", tenant).orderBy("valid_from").execute();
    for (const r of rows) {
      l.ids.set(r.code, r.calendar_id);
      l.maxValidFrom = later(l.maxValidFrom, r.valid_from);
      if (isOpen(r, asOf)) l.open.set(r.code, { id: r.calendar_id, validFrom: r.valid_from, source: r.source_system, attrs: stable(calendarAttrs(r.weekend_days, r.covered_through, r.holidays as never)) });
    }
    return l;
  },
  validate: (rows) => validateCalendars(rows),
  async write(tx, w) {
    const ids = new Map(w.loaded.ids);
    for (const k of w.plan.creates) if (!ids.has(k)) ids.set(k, randomUUID());
    for (const k of [...w.plan.changes, ...w.plan.ends]) {
      const cur = w.loaded.open.get(k)!;
      await closeVersion(tx, "calendars", "calendar_id", w.tenant, cur.id, cur.validFrom, w.asOf);
    }
    for (const k of [...w.plan.creates, ...w.plan.changes]) {
      const r = w.rows.get(k)!;
      const a = calendarAttrs(r.weekendDays, r.coveredThrough, r.holidays);
      await q(tx).insertInto("calendars").values({
        tenant_id: w.tenant, calendar_id: ids.get(k)!, valid_from: w.asOf, valid_to: null, source_system: w.source, batch_id: w.batchId,
        code: r.currencyCode, weekend_days: a.weekendDays, covered_through: a.coveredThrough, holidays: JSON.stringify(a.holidays),
      }).execute();
    }
  },
};

const OPS = { ENTITY: entityOps, HIERARCHY: hierarchyOps, ACCOUNT: accountOps, CURRENCY: currencyOps, CALENDAR: calendarOps } as unknown as Record<Kind, Ops<unknown>>;

async function maxEndShare(tx: Tx, tenant: TenantId): Promise<number> {
  const row = await q(tx).selectFrom("tenant_settings").select("max_end_share").where("tenant_id", "=", tenant).executeTakeFirst();
  return row ? Number(row.max_end_share) : DEFAULT_MAX_END_SHARE;
}

type Request =
  | { tenant: TenantId; kind: Kind; sub: Submission<unknown> }
  | { tenant: TenantId; release: { batchId: string; by: string } };

async function execute(db: Db, req: Request): Promise<SubmitResult> {
  let kind: Kind;
  let sub: Submission<unknown>;
  if ("release" in req) {
    const cs = await q(db).selectFrom("change_sets").selectAll().where("tenant_id", "=", req.tenant).where("batch_id", "=", req.release.batchId).executeTakeFirst();
    if (!cs || cs.status !== "HELD") throw new ChangeSetRefused("only a held change set can be released");
    kind = cs.kind as Kind;
    sub = { tenantId: req.tenant, sourceSystem: cs.source_system, asOf: cs.as_of as AsOfDate, mode: cs.mode as Mode, rows: cs.rows as unknown[], by: req.release.by };
  } else {
    kind = req.kind;
    sub = req.sub;
  }
  const ops = OPS[kind];
  const tenant = req.tenant;
  const releasing = "release" in req ? req.release : null;

  return db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant}:${kind}`}))`.execute(tx);

    if (releasing) {
      const again = await q(tx).selectFrom("change_sets").select("status").where("tenant_id", "=", tenant).where("batch_id", "=", releasing.batchId).executeTakeFirst();
      if (again?.status !== "HELD") throw new ChangeSetRefused("only a held change set can be released");
    }

    const rows = new Map(sub.rows.map((r) => [ops.keyOf(r), r]));
    const incoming = new Map([...rows].map(([k, r]) => [k, stable(ops.attrsOf(r))] as const));
    const hash = createHash("sha256").update(stable([sub.mode, [...incoming].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])).digest("hex");

    if (!releasing && sub.mode === "SNAPSHOT") {
      const dup = await q(tx).selectFrom("change_sets").select(["batch_id", "content_hash", "status"])
        .where("tenant_id", "=", tenant).where("source_system", "=", sub.sourceSystem).where("kind", "=", kind)
        .where("as_of", "=", sub.asOf).where("mode", "=", "SNAPSHOT").where("status", "<>", "REJECTED").executeTakeFirst();
      if (dup) {
        if (dup.content_hash !== hash) {
          throw new ChangeSetRefused(`a ${kind} snapshot from ${sub.sourceSystem} dated ${sub.asOf} was already sent with different content; reject it or use a new date`);
        }
        return { status: dup.status === "HELD" ? "HELD" : "DUPLICATE", batchId: dup.batch_id, created: 0, changed: 0, ended: 0, unchanged: 0 };
      }
    }

    const loaded = await ops.load(tx, tenant, sub.asOf);
    if (loaded.maxValidFrom !== null && loaded.maxValidFrom > sub.asOf) {
      throw new ChangeSetRefused(`${kind} master data already has a version from ${loaded.maxValidFrom}; a change set dated ${sub.asOf} would rewrite history`);
    }
    const problems = ops.validate(sub.rows, loaded, sub.mode);
    if (problems.length > 0) throw new ChangeSetInvalid(problems);

    const p = plan(loaded.open, incoming, sub.mode, sub.sourceSystem);
    const openForSource = [...loaded.open.values()].filter((o) => o.source === sub.sourceSystem).length;
    const share = await maxEndShare(tx, tenant);
    const hold = !releasing && sub.mode === "SNAPSHOT" && shouldHold(openForSource, p.ends.length, share);
    const heldReason = hold ? `would end ${p.ends.length} of ${openForSource} open rows (more than ${Math.round(share * 100)}%)` : undefined;
    const batchId = releasing?.batchId ?? randomUUID();

    if (!releasing) {
      await q(tx).insertInto("change_sets").values({
        tenant_id: tenant, batch_id: batchId, source_system: sub.sourceSystem, kind, mode: sub.mode, as_of: sub.asOf, content_hash: hash,
        status: hold ? "HELD" : "APPLIED", rows: JSON.stringify(sub.rows), open_count: openForSource, end_count: p.ends.length,
        held_reason: heldReason ?? null, created_by: sub.by,
      }).execute();
    }
    if (hold) return { status: "HELD", batchId, created: 0, changed: 0, ended: 0, unchanged: 0, heldReason };

    await ops.write(tx, { tenant, asOf: sub.asOf, source: sub.sourceSystem, batchId, rows, plan: p, loaded });
    if (releasing) {
      await q(tx).updateTable("change_sets").set({ status: "APPLIED", decided_by: releasing.by, decided_at: new Date() }).where("tenant_id", "=", tenant).where("batch_id", "=", batchId).execute();
    }
    if (p.creates.length + p.changes.length + p.ends.length > 0) {
      await announce(tx, { type: "master-data.changed", tenantId: tenant, batchId, kind, asOf: sub.asOf });
      const by = releasing ? releasing.by : sub.by;
      if (byPerson(by)) await recordChange(tx, { tenantId: tenant, programId: null, actor: by, action: `master-data.${String(kind).toLowerCase()}-changed`, targetType: "change-set", targetId: batchId, fields: [] });
    }
    return { status: "APPLIED", batchId, created: p.creates.length, changed: p.changes.length, ended: p.ends.length, unchanged: p.unchanged };
  });
}

export function applyCommands(db: Db) {
  return {
    applyEntities: (sub: Submission<EntityRow>) => execute(db, { tenant: sub.tenantId, kind: "ENTITY", sub }),
    applyHierarchy: (sub: Submission<HierarchyNodeRow>) => execute(db, { tenant: sub.tenantId, kind: "HIERARCHY", sub }),
    applyAccounts: (sub: Submission<AccountRow>) => execute(db, { tenant: sub.tenantId, kind: "ACCOUNT", sub }),
    applyCurrencies: (sub: Submission<CurrencyRow>) => execute(db, { tenant: sub.tenantId, kind: "CURRENCY", sub }),
    applyCalendars: (sub: Submission<CalendarRow>) => execute(db, { tenant: sub.tenantId, kind: "CALENDAR", sub }),

    /** Applies a held snapshot now. It is checked again against what exists today. */
    releaseChangeSet: (tenant: TenantId, batchId: string, by: string) => execute(db, { tenant, release: { batchId, by } }),

    async rejectChangeSet(tenant: TenantId, batchId: string, by: string): Promise<void> {
      const r = await q(db).updateTable("change_sets").set({ status: "REJECTED", decided_by: by, decided_at: new Date() })
        .where("tenant_id", "=", tenant).where("batch_id", "=", batchId).where("status", "=", "HELD").returning("batch_id").executeTakeFirst();
      if (!r) throw new ChangeSetRefused("only a held change set can be rejected");
    },

    async heldChangeSets(tenant: TenantId) {
      const rows = await q(db).selectFrom("change_sets")
        .select(["batch_id", "kind", "source_system", "as_of", "open_count", "end_count", "held_reason", "created_by", "created_at"])
        .where("tenant_id", "=", tenant).where("status", "=", "HELD").orderBy("created_at").execute();
      return rows.map((r) => ({
        batchId: r.batch_id, kind: r.kind as Kind, sourceSystem: r.source_system, asOf: r.as_of, openCount: r.open_count,
        endCount: r.end_count, reason: r.held_reason ?? "", submittedBy: r.created_by, submittedAt: r.created_at,
      }));
    },

    /** The share of a source's open rows a snapshot may end before it is held. 0 holds any ending; 1 never holds. */
    async setMaxEndShare(tenant: TenantId, share: number): Promise<void> {
      if (!(share >= 0 && share <= 1)) throw new RangeError("share must be between 0 and 1");
      await q(db).insertInto("tenant_settings").values({ tenant_id: tenant, max_end_share: share.toFixed(3) })
        .onConflict((oc) => oc.column("tenant_id").doUpdateSet({ max_end_share: share.toFixed(3), updated_at: new Date() })).execute();
    },
  };
}
