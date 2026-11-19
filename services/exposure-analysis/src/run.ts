// The run lifecycle (decision 0008): a run is saved when a cycle starts, collects what it needs, and completes only when it has all of it.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { asOfDate, cycleId as toCycleId, programId as toProgramId, type CycleId, type TenantId } from "@shared/kernel";
import type { RateWarning } from "../contract/index.ts";
import { buildBaseline, filterBalances, accountKey, fixed4, netByLevel, requiredRates, type Baseline, type GroupResult } from "./calc.ts";
import { q, type Db, type Queryable } from "./db.ts";
import { announce } from "./outbox.ts";
import type { Collaborators } from "./ports.ts";

/** The part of "cycle initiated" this service reads. */
export interface CycleInitiatedEvent {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly cycleId: CycleId;
}
export interface CycleApprovedEvent {
  readonly tenantId: TenantId;
  readonly cycleId: CycleId;
}
export type RunOutcome = "FINISHED" | "WAITING" | "IGNORED" | "DUPLICATE";

const CHUNK = 500;
const chunks = <T>(xs: readonly T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));
const lock = (tx: Queryable, key: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(tx);

export function runCommands(db: Db, c: Collaborators, now: () => Date) {
  async function wait(tenant: TenantId, runId: string, reason: string): Promise<RunOutcome> {
    await q(db).updateTable("runs").set({ wait_reason: reason, attempted_at: now() })
      .where("tenant_id", "=", tenant).where("run_id", "=", runId).where("status", "=", "WAITING").execute();
    return "WAITING";
  }

  /** Collect everything, then compute and save in one transaction. Nothing is saved but the reason when something is missing. */
  async function attempt(tenant: TenantId, runId: string): Promise<RunOutcome> {
    const run = await q(db).selectFrom("runs").selectAll().where("tenant_id", "=", tenant).where("run_id", "=", runId).executeTakeFirst();
    if (!run || run.status !== "WAITING") return "IGNORED";
    const asOf = asOfDate(run.as_of);
    const program = toProgramId(run.program_id);
    const level = run.netting_level as GroupResult["nettingLevel"];
    const display = run.display_currency;

    const balances = await c.dataSource.includedBalances({ tenantId: tenant, programId: program, asOf });
    if (balances.length === 0) return wait(tenant, runId, `No included balances for program ${run.program_id} on ${run.as_of}`);

    const entityCodes = [...new Set(balances.map((b) => b.entityCode))];
    const entities = new Map((await c.masterData.getEntities(tenant, entityCodes, asOf)).map((e) => [e.code, e]));
    const accountKeys = [...new Map(balances.map((b) => [accountKey(b.chartCode, b.accountNumber), { chartCode: b.chartCode, accountNumber: b.accountNumber }])).values()];
    const accounts = new Map((await c.masterData.getAccounts(tenant, accountKeys, asOf)).map((a) => [accountKey(a.chartCode, a.accountNumber), a]));
    const { kept, counts } = filterBalances(balances, entities, accounts);

    const regions = new Map<string, string>();
    for (const k of kept) {
      if (regions.has(k.entity.code)) continue;
      const above = await c.masterData.entityWalk(tenant, k.entity.entityId, "ancestors", asOf);
      regions.set(k.entity.code, above.find((e) => e.type === "REGION")?.code ?? "UNASSIGNED");
    }

    const needs = requiredRates(kept, level, display);
    const fetched = new Map<string, Awaited<ReturnType<Collaborators["rates"]["getRate"]>>>();
    for (const n of needs) {
      const key = `${n.base}|${n.quote}`;
      if (!fetched.has(key)) fetched.set(key, await c.rates.getRate({ tenantId: tenant, base: n.base, quote: n.quote, asOf, tenor: "SPOT" }));
    }
    const missing = [...fetched].filter(([, r]) => r === null).map(([k]) => k.replace("|", "-"));
    if (missing.length > 0) return wait(tenant, runId, `Missing spot rates on ${run.as_of} for ${missing.join(", ")}`);
    const rateOf = (base: string, quote: string): string => (base === quote ? "1" : fetched.get(`${base}|${quote}`)!.rate);
    const warnings: RateWarning[] = [...fetched.values()].flatMap((r) => (r!.quality === "VALID" ? [] : [{ base: r!.base, quote: r!.quote, quality: r!.quality }]));

    const blocked = (await c.dataSource.ingestionStatus(tenant, { asOf })).filter((s) => s.current).reduce((n, s) => n + s.blocked, 0);

    const baseline = buildBaseline(kept, rateOf, (code) => regions.get(code) ?? "UNASSIGNED");
    const groups = netByLevel(baseline, level, run.as_of, display, rateOf);
    return save(tenant, run.program_id, runId, { baseline, groups, counts, warnings, blocked, needs, fetched });
  }

  async function save(
    tenant: TenantId, program: string, runId: string,
    r: { baseline: Baseline[]; groups: GroupResult[]; counts: unknown; warnings: RateWarning[]; blocked: number; needs: ReturnType<typeof requiredRates>; fetched: Map<string, Awaited<ReturnType<Collaborators["rates"]["getRate"]>>> },
  ): Promise<RunOutcome> {
    return db.transaction().execute(async (tx) => {
      const run = await q(tx).selectFrom("runs").select(["status", "cycle_id", "display_currency"]).where("tenant_id", "=", tenant).where("run_id", "=", runId).executeTakeFirst();
      await lock(tx, `${tenant}:${run?.cycle_id}`);
      const again = await q(tx).selectFrom("runs").select("status").where("tenant_id", "=", tenant).where("run_id", "=", runId).executeTakeFirst();
      if (again?.status !== "WAITING") return "IGNORED"; // superseded by a rerun, or finished by a concurrent attempt
      const key = { tenant_id: tenant, program_id: program, run_id: runId };
      for (const part of chunks(r.baseline)) {
        await q(tx).insertInto("baseline_rows").values(part.map((b) => ({
          ...key, row_no: b.rowNo, source_system: b.kept.balance.lineage.sourceSystem, batch_id: b.kept.balance.lineage.batchId, record_id: b.kept.balance.lineage.recordId,
          entity_code: b.kept.balance.entityCode, region: b.region, chart_code: b.kept.balance.chartCode, account_number: b.kept.balance.accountNumber, period: b.kept.balance.asOf,
          transaction_currency: b.kept.balance.currency, functional_currency: b.kept.functionalCurrency, currency_pair: b.pair, currency1: b.kept.currency1, currency2: b.kept.currency2,
          pair_rate: b.rate, amount: fixed4(b.amount), amount1: fixed4(b.amount1), amount2: fixed4(b.amount2), dimensions: JSON.stringify(b.kept.balance.dimensions),
        }))).execute();
      }
      const display = run!.display_currency;
      for (const [i, g] of r.groups.entries()) {
        const groupNo = i + 1;
        await q(tx).insertInto("exposure_groups").values({
          ...key, group_no: groupNo, netting_level: g.nettingLevel, region: g.region, entity_code: g.entityCode, currency_pair: g.pair, currency1: g.currency1, currency2: g.currency2,
          exposure_currency: g.exposureCurrency, period: g.period, row_count: g.members.length, long1: fixed4(g.long1), short1: fixed4(g.short1), net1: fixed4(g.net1), net2: fixed4(g.net2),
          exposure_amount: fixed4(g.exposureAmount), display_currency: display, display_rate: g.displayRate, display_amount: fixed4(g.displayAmount),
        }).execute();
        for (const part of chunks(g.members)) {
          await q(tx).insertInto("group_members").values(part.map((m) => ({ ...key, group_no: groupNo, row_no: m.rowNo, amount1: fixed4(m.amount1), amount2: fixed4(m.amount2) }))).execute();
        }
      }
      const rateRows = r.needs.map((n) => {
        const f = r.fetched.get(`${n.base}|${n.quote}`)!;
        return { ...key, base: n.base, quote: n.quote, purpose: n.purpose, rate: f.rate, quality: f.quality, derivation: f.derivation, source: f.source, load_ids: JSON.stringify(f.loadIds) };
      });
      if (rateRows.length > 0) await q(tx).insertInto("rates_used").values(rateRows).execute();
      await q(tx).updateTable("runs").set({
        status: "FINISHED", wait_reason: null, counts: JSON.stringify(r.counts), blocked_count: r.blocked, warnings: JSON.stringify(r.warnings), attempted_at: now(), finished_at: now(),
      }).where("tenant_id", "=", tenant).where("run_id", "=", runId).execute();
      const base = { tenantId: tenant, cycleId: toCycleId(run!.cycle_id), programId: toProgramId(program), runId };
      await announce(tx, { type: "exposure-analysis.run-started", ...base });
      await announce(tx, { type: "exposure-analysis.run-finished", ...base });
      return "FINISHED";
    });
  }

  return {
    /** A cycle started or was rerun. Saves a run and tries it. The same event twice does nothing the second time. */
    async onCycleInitiated(event: CycleInitiatedEvent): Promise<RunOutcome> {
      const cycle = await c.management.getCycle(event.tenantId, event.cycleId);
      if (!cycle || cycle.outcome !== null || cycle.approvedAt !== null || cycle.stage !== "INITIATED") return "IGNORED";
      const runId = await db.transaction().execute(async (tx) => {
        await lock(tx, `${event.tenantId}:${event.cycleId}`);
        if (await q(tx).selectFrom("runs").select("run_id").where("tenant_id", "=", event.tenantId).where("trigger_event_id", "=", event.eventId).executeTakeFirst()) return "DUPLICATE";
        const current = await q(tx).selectFrom("runs").select(["run_id", "frozen_at"]).where("tenant_id", "=", event.tenantId).where("cycle_id", "=", event.cycleId).where("status", "<>", "SUPERSEDED").executeTakeFirst();
        if (current?.frozen_at) return "IGNORED";
        if (current) await q(tx).updateTable("runs").set({ status: "SUPERSEDED", wait_reason: null }).where("tenant_id", "=", event.tenantId).where("run_id", "=", current.run_id).execute();
        const id = randomUUID();
        await q(tx).insertInto("runs").values({
          tenant_id: event.tenantId, run_id: id, program_id: cycle.programId, cycle_id: event.cycleId, as_of: cycle.asOf, trigger_event_id: event.eventId, status: "WAITING",
          wait_reason: "Not collected yet", netting_level: cycle.settings.nettingLevel, display_currency: cycle.settings.displayCurrency,
        }).execute();
        return id;
      });
      if (runId === "DUPLICATE" || runId === "IGNORED") return runId;
      return attempt(event.tenantId, runId);
    },

    /** Try the tenant's waiting runs again, after data or rates changed. Returns how many finished. */
    async retryWaiting(tenant: TenantId): Promise<number> {
      const waiting = await q(db).selectFrom("runs").select("run_id").where("tenant_id", "=", tenant).where("status", "=", "WAITING").orderBy("created_at").execute();
      let done = 0;
      for (const w of waiting) if ((await attempt(tenant, w.run_id)) === "FINISHED") done++;
      return done;
    },

    /** The cycle was approved: its current run never changes again. */
    async onCycleApproved(event: CycleApprovedEvent): Promise<void> {
      await q(db).updateTable("runs").set({ frozen_at: now() })
        .where("tenant_id", "=", event.tenantId).where("cycle_id", "=", event.cycleId).where("status", "=", "FINISHED").where("frozen_at", "is", null).execute();
    },
  };
}

