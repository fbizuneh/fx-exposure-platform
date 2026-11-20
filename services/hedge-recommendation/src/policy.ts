// The hedge policy of a program (decision 0011 items 3 to 9). Saved whole: what is sent replaces what was there.
import type { ProgramId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { require_, who } from "./access.ts";
import { TENOR } from "./calc.ts";
import { q, type Db } from "./db.ts";
import type { Collaborators } from "./ports.ts";

export interface PolicyInput {
  readonly defaultRatio: string;
  readonly ratioOverrides: readonly { readonly pair: string; readonly ratio: string }[];
  readonly minHedgeDisplay: string;
  readonly roundingDefault: string;
  readonly roundingOverrides: readonly { readonly currency: string; readonly rounding: string }[];
  readonly tenor: string;
  readonly tradingEntityCode: string | null;
}

export class PolicyInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the hedge policy is not valid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const NUMBER = /^\d+(\.\d{1,6})?$/;
export function policyProblems(p: PolicyInput): string[] {
  const out: string[] = [];
  const ratio = (label: string, v: string) => { if (!NUMBER.test(v) || Number(v) > 10) out.push(`${label} must be a decimal from 0 to 10 (1 is 100%)`); };
  const positive = (label: string, v: string) => { if (!NUMBER.test(v) || Number(v) <= 0) out.push(`${label} must be a decimal above 0`); };
  ratio("default ratio", p.defaultRatio);
  if (!NUMBER.test(p.minHedgeDisplay)) out.push("minimum hedge amount must be a decimal of 0 or more");
  positive("default rounding", p.roundingDefault);
  if (!TENOR.test(p.tenor)) out.push('tenor must look like "1M" or "2W"');
  const pairs = new Set<string>();
  for (const o of p.ratioOverrides) {
    if (!/^[A-Z]{3}-[A-Z]{3}$/.test(o.pair)) out.push(`ratio override pair ${o.pair} must look like EUR-USD`);
    if (pairs.has(o.pair)) out.push(`ratio override for ${o.pair} appears twice`);
    pairs.add(o.pair);
    ratio(`ratio override ${o.pair}`, o.ratio);
  }
  const ccys = new Set<string>();
  for (const o of p.roundingOverrides) {
    if (!/^[A-Z]{3}$/.test(o.currency)) out.push(`rounding override currency ${o.currency} must be three letters`);
    if (ccys.has(o.currency)) out.push(`rounding override for ${o.currency} appears twice`);
    ccys.add(o.currency);
    positive(`rounding override ${o.currency}`, o.rounding);
  }
  return out;
}

export function policyCommands(db: Db, c: Collaborators, clock: () => Date) {
  async function setPolicy(input: { tenantId: TenantId; programId: ProgramId; actor: Actor; policy: PolicyInput }): Promise<void> {
    await require_(c.access, input.tenantId, input.actor, "hedge-policy:manage", input.programId);
    const problems = policyProblems(input.policy);
    if (problems.length > 0) throw new PolicyInvalid(problems);
    const p = input.policy;
    const key = { tenant_id: input.tenantId, program_id: input.programId };
    await db.transaction().execute(async (tx) => {
      await q(tx).deleteFrom("policies").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).deleteFrom("ratio_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).deleteFrom("rounding_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).insertInto("policies").values({
        ...key, default_ratio: p.defaultRatio, min_hedge_display: p.minHedgeDisplay, rounding_default: p.roundingDefault, tenor: p.tenor,
        trading_entity_code: p.tradingEntityCode, updated_by: who(input.actor), updated_at: clock(),
      }).execute();
      if (p.ratioOverrides.length > 0) await q(tx).insertInto("ratio_overrides").values(p.ratioOverrides.map((o) => ({ ...key, currency_pair: o.pair, ratio: o.ratio }))).execute();
      if (p.roundingOverrides.length > 0) await q(tx).insertInto("rounding_overrides").values(p.roundingOverrides.map((o) => ({ ...key, currency: o.currency, rounding: o.rounding }))).execute();
    });
  }
  return { setPolicy };
}
