// Mapping rules and the program catalog. A rule is added and later ended, never edited.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { programId as toProgramId, type AsOfDate, type TenantId } from "@shared/kernel";
import type { MasterDataQuestionsLike } from "./ports.ts";
import { byPerson, recordChange } from "./change-record.ts";
import { q, type Db } from "./db.ts";
import { firstSharedDate, scopesMeet } from "./match.ts";
import type { MappingRule, RuleKind, RuleTarget } from "./rows.ts";
import { toRule } from "./intake.ts";

export class RuleInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`mapping rule refused: ${problems.slice(0, 3).join("; ")}`);
    this.problems = problems;
  }
}

export interface NewRule {
  readonly tenantId: TenantId;
  readonly programId: string;
  readonly kind: RuleKind;
  readonly target: RuleTarget;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceSystem?: string | null;
  readonly entityCode?: string | null;
  readonly dimensions?: Readonly<Record<string, readonly string[]>> | null;
  readonly by: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (v: string) => ISO.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const filled = (v: string | undefined | null): v is string => typeof v === "string" && v.trim() !== "" && v === v.trim();

export function ruleCommands(db: Db, md: MasterDataQuestionsLike) {
  /** The accounts a rule target covers on a date, as "chart:number". */
  async function accountsOf(tenant: TenantId, t: RuleTarget, date: string): Promise<Set<string>> {
    if (t.type === "ACCOUNT") return new Set([`${t.chartCode}:${t.accountNumber}`]);
    const found = await md.accountsUnderNode(tenant, t.chartCode, t.nodeCode, date as AsOfDate);
    return new Set(found.map((a) => `${a.chartCode}:${a.accountNumber}`));
  }

  async function addMappingRule(input: NewRule): Promise<string> {
    const problems: string[] = [];
    if (!filled(input.programId)) problems.push("program is required");
    if (!filled(input.target.chartCode)) problems.push("chart code is required");
    if (!filled(input.target.type === "ACCOUNT" ? input.target.accountNumber : input.target.nodeCode)) problems.push("the account or node code is required");
    if (!realDate(input.validFrom)) problems.push("valid-from is not a date");
    if (input.validTo !== null && !realDate(input.validTo)) problems.push("valid-to is not a date");
    if (realDate(input.validFrom) && input.validTo !== null && realDate(input.validTo) && input.validTo <= input.validFrom) problems.push("valid-to must be after valid-from");
    for (const [name, values] of Object.entries(input.dimensions ?? {})) {
      if (!filled(name) || values.length === 0 || !values.every(filled)) problems.push(`dimension ${name} needs one or more values`);
    }
    if (problems.length > 0) throw new RuleInvalid(problems);

    const tenant = input.tenantId;
    return db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenant}:rules`}))`.execute(tx);
      const program = await q(tx).selectFrom("programs").select("program_id").where("tenant_id", "=", tenant).where("program_id", "=", input.programId).executeTakeFirst();
      if (!program) throw new RuleInvalid([`program ${input.programId} is not in the catalog`]);

      const ruleId = randomUUID();
      const next: MappingRule = {
        ruleId, programId: input.programId, kind: input.kind, target: input.target, validFrom: input.validFrom, validTo: input.validTo,
        sourceSystem: input.sourceSystem ?? null, entityCode: input.entityCode ?? null, dimensions: input.dimensions ?? null,
      };

      if (next.kind === "INCLUDE") {
        const all = (await q(tx).selectFrom("mapping_rules").selectAll().where("tenant_id", "=", tenant).execute()).map(toRule);
        for (const other of all.filter((r) => r.kind === "INCLUDE" && r.programId !== next.programId)) {
          const day = scopesMeet(next, other) ? firstSharedDate(next, other) : null;
          if (day === null) continue;
          const shared = [...(await accountsOf(tenant, next.target, day))];
          const theirs = await accountsOf(tenant, other.target, day);
          const both = shared.filter((a) => theirs.has(a));
          if (both.length === 0) continue;
          const removed = new Set<string>();
          for (const ex of all.filter((r) => r.kind === "EXCLUDE" && (r.programId === next.programId || r.programId === other.programId))) {
            for (const a of await accountsOf(tenant, ex.target, day)) removed.add(a);
          }
          const left = both.filter((a) => !removed.has(a));
          if (left.length > 0) {
            throw new RuleInvalid([`programs ${next.programId} and ${other.programId} would both claim ${left.slice(0, 3).join(", ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""} from ${day}`]);
          }
        }
      }

      await q(tx).insertInto("mapping_rules").values({
        tenant_id: tenant, rule_id: ruleId, program_id: next.programId, kind: next.kind, target_type: next.target.type, chart_code: next.target.chartCode,
        target_code: next.target.type === "ACCOUNT" ? next.target.accountNumber : next.target.nodeCode, valid_from: next.validFrom, valid_to: next.validTo,
        source_system: next.sourceSystem, entity_code: next.entityCode, dimensions: next.dimensions === null ? null : JSON.stringify(next.dimensions), created_by: input.by,
      }).execute();
      if (byPerson(input.by)) await recordChange(tx, { tenantId: tenant, programId: toProgramId(next.programId), actor: input.by, action: "mapping-rule.added", targetType: "mapping-rule", targetId: ruleId, fields: [] });
      return ruleId;
    });
  }

  return {
    addMappingRule,

    /** Stops a rule applying from `endsOn` (exclusive). Only ever shortens it. */
    async endMappingRule(tenant: TenantId, ruleId: string, endsOn: string, by: string): Promise<void> {
      if (!realDate(endsOn)) throw new RuleInvalid(["end date is not a date"]);
      return db.transaction().execute(async (tx) => {
        const r = await q(tx).selectFrom("mapping_rules").select(["program_id", "valid_from", "valid_to"]).where("tenant_id", "=", tenant).where("rule_id", "=", ruleId).executeTakeFirst();
        if (!r) throw new RuleInvalid(["rule not found"]);
        if (endsOn <= r.valid_from) throw new RuleInvalid(["the end date must be after the rule starts"]);
        if (r.valid_to !== null && endsOn >= r.valid_to) throw new RuleInvalid(["a rule can only be shortened"]);
        await q(tx).updateTable("mapping_rules").set({ valid_to: endsOn }).where("tenant_id", "=", tenant).where("rule_id", "=", ruleId).execute();
        if (byPerson(by)) await recordChange(tx, { tenantId: tenant, programId: toProgramId(r.program_id), actor: by, action: "mapping-rule.ended", targetType: "mapping-rule", targetId: ruleId, fields: ["validTo"] });
      });
    },

    /** The program catalog copy. The app feeds it from Exposure Management's events. */
    async upsertProgram(tenant: TenantId, program: { programId: string; type: string; enabled: boolean }): Promise<void> {
      if (!filled(program.programId) || !filled(program.type)) throw new RangeError("program ID and type are required");
      await q(db).insertInto("programs").values({ tenant_id: tenant, program_id: program.programId, program_type: program.type, enabled: program.enabled })
        .onConflict((oc) => oc.columns(["tenant_id", "program_id"]).doUpdateSet({ program_type: program.type, enabled: program.enabled, updated_at: new Date() })).execute();
    },
  };
}
