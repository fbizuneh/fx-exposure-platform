// The one write path for balances: a batch from one source system, chart and as-of date, validated and stamped
// in one transaction with its events (docs/decisions/0006).
import { createHash, randomUUID } from "node:crypto";
import { sql, type Insertable } from "kysely";
import { asOfDate, type AsOfDate, type TenantId } from "@shared/kernel";
import type { BatchStatus, MasterDataQuestionsLike } from "./ports.ts";
import { q, type Db } from "./db.ts";
import type { DataSourceDatabase } from "./schema.ts";
import { matchProgram, type MatchFact } from "./match.ts";
import { announce } from "./outbox.ts";
import type { GlBalanceRow, MappingRule } from "./rows.ts";
import { checkRow, MAX_ROWS, recordKey, type RowIssue } from "./validate.ts";

export interface GlBatch {
  readonly tenantId: TenantId;
  readonly sourceSystem: string;
  readonly chartCode: string;
  readonly asOf: AsOfDate;
  readonly rows: readonly GlBalanceRow[];
  /** Who or what sent it: a user id or a connector name. */
  readonly by: string;
}

export interface BatchResult {
  readonly status: "APPLIED" | "DUPLICATE";
  readonly batchId: string;
  readonly ingestion: BatchStatus;
  readonly received: number;
  readonly included: number;
  readonly excluded: number;
  readonly blocked: number;
}

/** The batch as a whole cannot be taken. batchId is set when the refusal was recorded as a FAILED batch. */
export class BatchRefused extends Error {
  readonly batchId: string | null;
  constructor(batchId: string | null, message: string) {
    super(message);
    this.batchId = batchId;
  }
}

const CODE = /^[A-Za-z0-9._-]{1,64}$/;
const CHUNK = 500;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const blank = (v: string | null): boolean => v === null || v.trim() === "";
const chunks = <T>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

export function intakeCommands(db: Db, md: MasterDataQuestionsLike, clock: () => Date) {
  async function submitGlBatch(batch: GlBatch): Promise<BatchResult> {
    if (!CODE.test(batch.sourceSystem)) throw new BatchRefused(null, "source system must be letters, digits, dot, dash or underscore");
    if (!CODE.test(batch.chartCode)) throw new BatchRefused(null, "chart code must be letters, digits, dot, dash or underscore");
    try {
      asOfDate(batch.asOf);
    } catch {
      throw new BatchRefused(null, "as-of date must be a real date written YYYY-MM-DD");
    }
    const tenant = batch.tenantId;
    const today = clock().toISOString().slice(0, 10);
    const reason = batch.rows.length === 0 ? "the batch has no rows" : batch.rows.length > MAX_ROWS ? `the batch has more than ${MAX_ROWS} rows` : batch.asOf > today ? `as-of date ${batch.asOf} is in the future` : null;
    const hash = createHash("sha256").update(stable([batch.chartCode, batch.rows.map((r) => stable(r)).sort()])).digest("hex");
    if (reason !== null) {
      const id = randomUUID();
      await q(db).insertInto("batches").values({
        tenant_id: tenant, batch_id: id, source_system: batch.sourceSystem, as_of: batch.asOf, chart_code: batch.chartCode, content_hash: hash,
        status: "FAILED", failure_reason: reason, received_count: batch.rows.length, received_by: batch.by,
      }).execute();
      throw new BatchRefused(id, reason);
    }

    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant}:${batch.sourceSystem}:${batch.asOf}`}))`.execute(tx);

      const dup = await q(tx).selectFrom("batches").select(["batch_id", "status", "received_count", "included_count", "excluded_count", "blocked_count"])
        .where("tenant_id", "=", tenant).where("source_system", "=", batch.sourceSystem).where("as_of", "=", batch.asOf)
        .where("content_hash", "=", hash).where("superseded_by", "is", null).where("status", "<>", "FAILED").executeTakeFirst();
      if (dup) {
        return {
          status: "DUPLICATE", batchId: dup.batch_id, ingestion: dup.status as BatchStatus, received: dup.received_count,
          included: dup.included_count, excluded: dup.excluded_count, blocked: dup.blocked_count,
        } as const;
      }

      // What intake needs from other services, asked once for the whole batch.
      const entityCodes = [...new Set(batch.rows.filter((r) => !blank(r.entityCode)).map((r) => r.entityCode!))];
      const accountNumbers = [...new Set(batch.rows.filter((r) => !blank(r.accountNumber)).map((r) => r.accountNumber!))];
      const entities = new Map((await md.getEntities(tenant, entityCodes, batch.asOf)).map((e) => [e.code, e]));
      const accounts = new Map(
        (await md.getAccounts(tenant, accountNumbers.map((accountNumber) => ({ chartCode: batch.chartCode, accountNumber })), batch.asOf)).map((a) => [a.accountNumber, a]),
      );
      const nodeCodes = [...new Set([...accounts.values()].map((a) => a.hierarchyNodeCode).filter((c): c is string => c !== null))];
      const paths = new Map((await md.hierarchyPaths(tenant, batch.chartCode, nodeCodes, batch.asOf)).map((p) => [p.nodeCode, p.path]));

      const ruleRows = await q(tx).selectFrom("mapping_rules").selectAll().where("tenant_id", "=", tenant)
        .where("valid_from", "<=", batch.asOf).where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", batch.asOf)])).execute();
      const rules: MappingRule[] = ruleRows.map(toRule);
      const programs = new Map((await q(tx).selectFrom("programs").select(["program_id", "enabled"]).where("tenant_id", "=", tenant).execute()).map((p) => [p.program_id, p.enabled]));

      const keys = batch.rows.map((r) => recordKey(r));
      const complete = (r: GlBalanceRow) => !blank(r.entityCode) && !blank(r.accountNumber) && !blank(r.currency);
      const seen = new Map<string, number>();
      batch.rows.forEach((r, i) => complete(r) && seen.set(keys[i]!, (seen.get(keys[i]!) ?? 0) + 1));

      const batchId = randomUUID();
      const balances: Insertable<DataSourceDatabase["balances"]>[] = [];
      const issues: { balance_id: string; ruleCode: string; description: string }[] = [];
      let included = 0;
      let excluded = 0;
      let blocked = 0;

      batch.rows.forEach((r, i) => {
        const key = keys[i]!;
        const { amount, issues: found } = checkRow(r, batch.asOf);
        const problems: RowIssue[] = [...found];
        const entity = blank(r.entityCode) ? undefined : entities.get(r.entityCode!);
        const account = blank(r.accountNumber) ? undefined : accounts.get(r.accountNumber!);
        if (!blank(r.entityCode) && !entity) problems.push({ ruleCode: "GL_ENTITY_UNKNOWN", description: `Entity ${r.entityCode} is not in master data on ${batch.asOf}` });
        if (!blank(r.accountNumber) && !account) problems.push({ ruleCode: "GL_ACCOUNT_UNKNOWN", description: `Account ${r.accountNumber} is not in chart ${batch.chartCode} on ${batch.asOf}` });
        if (complete(r) && (seen.get(key) ?? 0) > 1) problems.push({ ruleCode: "GL_DUPLICATE_KEY", description: `${seen.get(key)} rows share the key ${key}; none can be trusted` });

        let outcome: "INCLUDED" | "EXCLUDED" | "BLOCKED" = "BLOCKED";
        let programId: string | null = null;
        let matched: readonly string[] = [];
        if (problems.length === 0 && entity && account) {
          const fact: MatchFact = {
            chartCode: batch.chartCode, accountNumber: account.accountNumber, hierarchyPath: account.hierarchyNodeCode ? (paths.get(account.hierarchyNodeCode) ?? []) : [],
            entityCode: entity.code, sourceSystem: batch.sourceSystem, dimensions: r.dimensions, asOf: batch.asOf,
          };
          const m = matchProgram(rules, fact);
          matched = m.matchedRuleIds;
          if (m.outcome === "EXCLUDED") outcome = "EXCLUDED";
          else if (m.outcome === "UNMATCHED") problems.push({ ruleCode: "GL_PROGRAM_UNMATCHED", description: "No mapping rule assigns this balance to a program" });
          else if (m.outcome === "MULTI_MATCH") problems.push({ ruleCode: "GL_PROGRAM_MULTI_MATCH", description: `Programs ${m.claimingPrograms.join(", ")} all claim this balance` });
          else if (programs.get(m.programId!) !== true) problems.push({ ruleCode: "GL_PROGRAM_NOT_ACTIVE", description: `Program ${m.programId} is unknown or disabled` });
          else {
            outcome = "INCLUDED";
            programId = m.programId;
          }
        }
        if (problems.length > 0) outcome = "BLOCKED";
        if (outcome === "INCLUDED") included++;
        else if (outcome === "EXCLUDED") excluded++;
        else blocked++;

        const balanceId = randomUUID();
        for (const p of problems) issues.push({ balance_id: balanceId, ruleCode: p.ruleCode, description: p.description });
        balances.push({
          tenant_id: tenant, balance_id: balanceId, batch_id: batchId, source_system: batch.sourceSystem, as_of: batch.asOf, row_number: i + 1, record_key: key,
          entity_code: blank(r.entityCode) ? null : r.entityCode, entity_id: entity ? entity.entityId : null, chart_code: batch.chartCode,
          account_number: blank(r.accountNumber) ? null : r.accountNumber, account_id: account ? account.accountId : null,
          currency: blank(r.currency) ? null : r.currency, amount, dimensions: JSON.stringify(r.dimensions), outcome, program_id: programId,
          matched_rule_ids: JSON.stringify(matched), raw: outcome === "BLOCKED" ? JSON.stringify(r) : null,
        });
      });

      const status: BatchStatus = blocked > 0 ? "COMPLETED_WITH_ISSUES" : "COMPLETED";
      await q(tx).insertInto("batches").values({
        tenant_id: tenant, batch_id: batchId, source_system: batch.sourceSystem, as_of: batch.asOf, chart_code: batch.chartCode, content_hash: hash, status,
        failure_reason: null, received_count: batch.rows.length, included_count: included, excluded_count: excluded, blocked_count: blocked, received_by: batch.by,
      }).execute();

      // The earlier batch for this source and date is replaced. Its issues are about data that no longer counts.
      const replaced = await q(tx).updateTable("batches").set({ superseded_by: batchId })
        .where("tenant_id", "=", tenant).where("source_system", "=", batch.sourceSystem).where("as_of", "=", batch.asOf)
        .where("superseded_by", "is", null).where("status", "<>", "FAILED").where("batch_id", "<>", batchId).returning("batch_id").execute();
      if (replaced.length > 0) {
        await q(tx).updateTable("data_quality_issues").set({ status: "RESOLVED", resolved_at: new Date() })
          .where("tenant_id", "=", tenant).where("batch_id", "in", replaced.map((b) => b.batch_id)).where("status", "=", "OPEN").execute();
      }

      for (const part of chunks(balances)) await q(tx).insertInto("balances").values(part).execute();
      for (const part of chunks(issues)) {
        await q(tx).insertInto("data_quality_issues").values(part.map((p) => ({
          tenant_id: tenant, issue_id: randomUUID(), batch_id: batchId, balance_id: p.balance_id, rule_code: p.ruleCode, severity: "ERROR" as const,
          description: p.description, status: "OPEN" as const, resolved_at: null,
        }))).execute();
      }

      await announce(tx, { type: "data-source.batch-stamped", tenantId: tenant, batchId, sourceSystem: batch.sourceSystem, asOf: batch.asOf });
      if (issues.length > 0) await announce(tx, { type: "data-source.issues-raised", tenantId: tenant, batchId });
      return { status: "APPLIED", batchId, ingestion: status, received: batch.rows.length, included, excluded, blocked } as const;
    });
  }
  return { submitGlBatch };
}

export function toRule(r: { rule_id: string; program_id: string; kind: "INCLUDE" | "EXCLUDE"; target_type: "ACCOUNT" | "NODE"; chart_code: string; target_code: string; valid_from: string; valid_to: string | null; source_system: string | null; entity_code: string | null; dimensions: unknown }): MappingRule {
  const dims = typeof r.dimensions === "string" ? JSON.parse(r.dimensions) : r.dimensions;
  return {
    ruleId: r.rule_id, programId: r.program_id, kind: r.kind, validFrom: r.valid_from, validTo: r.valid_to, sourceSystem: r.source_system, entityCode: r.entity_code,
    dimensions: (dims as Record<string, string[]> | null) ?? null,
    target: r.target_type === "ACCOUNT" ? { type: "ACCOUNT", chartCode: r.chart_code, accountNumber: r.target_code } : { type: "NODE", chartCode: r.chart_code, nodeCode: r.target_code },
  };
}
