// The questions Data Source answers.
import { sql } from "kysely";
import { accountId, entityId, lineageRef, programId, type AsOfDate } from "@shared/kernel";
import type { CurrencyControlTotal, DataSourceQuestions } from "../contract/index.ts";
import { D } from "./control-totals.ts";
import { q, type Db } from "./db.ts";

const asDims = (v: unknown): Record<string, string> => (typeof v === "string" ? JSON.parse(v) : (v as Record<string, string>)) ?? {};

export function dataSourceQuestions(db: Db): DataSourceQuestions {
  return {
    async includedBalances(query) {
      let sel = q(db)
        .selectFrom("balances as b")
        .innerJoin("batches as c", (j) => j.onRef("c.tenant_id", "=", "b.tenant_id").onRef("c.batch_id", "=", "b.batch_id"))
        .select(["b.batch_id", "b.source_system", "b.record_key", "b.program_id", "b.as_of", "b.entity_id", "b.entity_code", "b.account_id", "b.chart_code", "b.account_number", "b.currency", "b.amount", "b.dimensions"])
        .where("b.tenant_id", "=", query.tenantId).where("b.program_id", "=", query.programId).where("b.as_of", "=", query.asOf)
        .where("b.outcome", "=", "INCLUDED").where("c.superseded_by", "is", null).where("c.status", "<>", "FAILED");
      if (query.sourceSystem) sel = sel.where("b.source_system", "=", query.sourceSystem);
      if (query.entityIds) {
        if (query.entityIds.length === 0) return [];
        sel = sel.where("b.entity_id", "in", [...query.entityIds]);
      }
      const rows = await sel.orderBy("b.source_system").orderBy("b.record_key").execute();
      return rows.map((r) => ({
        lineage: lineageRef(r.source_system, r.batch_id, r.record_key),
        programId: programId(r.program_id!),
        asOf: r.as_of as AsOfDate,
        entityId: entityId(r.entity_id!),
        entityCode: r.entity_code!,
        accountId: accountId(r.account_id!),
        chartCode: r.chart_code,
        accountNumber: r.account_number!,
        currency: r.currency!,
        amount: r.amount!,
        dimensions: asDims(r.dimensions),
      }));
    },

    async ingestionStatus(tenant, filter) {
      let sel = q(db).selectFrom("batches").selectAll().where("tenant_id", "=", tenant);
      if (filter?.sourceSystem) sel = sel.where("source_system", "=", filter.sourceSystem);
      if (filter?.asOf) sel = sel.where("as_of", "=", filter.asOf);
      const rows = await sel.orderBy("received_at", "desc").orderBy("batch_id").limit(1000).execute();
      return rows.map((r) => ({
        batchId: r.batch_id, sourceSystem: r.source_system, asOf: r.as_of as AsOfDate, status: r.status, current: r.superseded_by === null && r.status !== "FAILED",
        received: r.received_count, included: r.included_count, excluded: r.excluded_count, blocked: r.blocked_count, failureReason: r.failure_reason, receivedAt: r.received_at.toISOString(),
      }));
    },

    async dataQualityIssues(tenant, filter) {
      let sel = q(db)
        .selectFrom("data_quality_issues as i")
        .innerJoin("batches as c", (j) => j.onRef("c.tenant_id", "=", "i.tenant_id").onRef("c.batch_id", "=", "i.batch_id"))
        .leftJoin("balances as b", (j) => j.onRef("b.tenant_id", "=", "i.tenant_id").onRef("b.balance_id", "=", "i.balance_id"))
        .select(["i.issue_id", "i.batch_id", "i.rule_code", "i.severity", "i.description", "i.status", "i.raised_at", "c.source_system", "b.record_key"])
        .where("i.tenant_id", "=", tenant);
      if (filter?.batchId) sel = sel.where("i.batch_id", "=", filter.batchId);
      if (filter?.asOf) sel = sel.where("c.as_of", "=", filter.asOf);
      if (filter?.status) sel = sel.where("i.status", "=", filter.status);
      const rows = await sel.orderBy("i.raised_at", "desc").orderBy("i.issue_id").limit(Math.min(Math.max(filter?.limit ?? 1000, 1), 5000)).execute();
      return rows.map((r) => ({
        issueId: r.issue_id, batchId: r.batch_id, lineage: r.record_key === null ? null : lineageRef(r.source_system, r.batch_id, r.record_key),
        ruleCode: r.rule_code, severity: r.severity, description: r.description, status: r.status, raisedAt: r.raised_at.toISOString(),
      }));
    },

    async controlTotals(tenant, batchId) {
      const owns = await q(db).selectFrom("batches").select("batch_id").where("tenant_id", "=", tenant).where("batch_id", "=", batchId).executeTakeFirst();
      if (!owns) throw new Error("no such batch");
      const rows = await q(db)
        .selectFrom("balances")
        .select(["currency", "outcome", sql<string>`count(*)`.as("row_count"), sql<string>`coalesce(sum(amount), 0)`.as("sum")])
        .where("tenant_id", "=", tenant).where("batch_id", "=", batchId)
        .groupBy(["currency", "outcome"])
        .execute();

      type Bucket = { rows: number; sum: InstanceType<typeof D> };
      const zero = (): Bucket => ({ rows: 0, sum: new D(0) });
      const byCurrency = new Map<string, { included: Bucket; excluded: Bucket; blocked: Bucket }>();
      for (const r of rows) {
        const currency = r.currency ?? "";
        const entry = byCurrency.get(currency) ?? { included: zero(), excluded: zero(), blocked: zero() };
        const bucket: Bucket = { rows: Number(r.row_count), sum: new D(r.sum) };
        if (r.outcome === "INCLUDED") entry.included = bucket;
        else if (r.outcome === "EXCLUDED") entry.excluded = bucket;
        else entry.blocked = bucket;
        byCurrency.set(currency, entry);
      }

      const totals: CurrencyControlTotal[] = [...byCurrency.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, g]) => ({
          currency,
          receivedRows: g.included.rows + g.excluded.rows + g.blocked.rows,
          receivedSum: g.included.sum.plus(g.excluded.sum).plus(g.blocked.sum).toFixed(4),
          includedRows: g.included.rows,
          includedSum: g.included.sum.toFixed(4),
          excludedRows: g.excluded.rows,
          excludedSum: g.excluded.sum.toFixed(4),
          blockedRows: g.blocked.rows,
          blockedSum: g.blocked.sum.toFixed(4),
        }));
      return totals;
    },
  };
}
