// The hedge policy of a program (decision 0011 items 3 to 9). Saved whole: what is sent replaces what was there.
import type { ProgramId, TenantId } from "@shared/kernel";
import type { Actor } from "@services/identity/contract";
import { require_, who } from "./access.ts";
import { recordChange } from "./change-record.ts";
import { readPolicy } from "./queries.ts";
import type { NettingLevel } from "@services/exposure-management/contract";
import { SPLIT_METHODS, STRATEGIES, type SplitMethod, type Strategy } from "../contract/index.ts";
import { TENOR, pairKey } from "./calc.ts";
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
  /** Decision 0016. Left out, there is no maximum, no override and the split is even. */
  readonly maxHedgeDisplay?: string | null;
  readonly maxHedgeOverrides?: readonly { readonly nettingLevel: string; readonly maxHedgeDisplay: string }[];
  readonly splitMethod?: SplitMethod;
  /** Decision 0020. Left out, the program uses hedge-ratio-adjustment and has no threshold. */
  readonly strategy?: Strategy;
  readonly amountThresholdDisplay?: string | null;
  readonly amountThresholdOverrides?: readonly { readonly nettingLevel: string; readonly amountThresholdDisplay: string }[];
}

export class PolicyInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the hedge policy is not valid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** The netting levels a cycle can run at (Exposure Management's list; the type check keeps every name here a real level). */
const NETTING_LEVELS = ["GROUP_NATURAL", "GROUP_PORTFOLIO", "REGION", "REGION_BY_ENTITY", "ENTITY"] as const satisfies readonly NettingLevel[];

const NUMBER = /^\d+(\.\d{1,6})?$/;
export function policyProblems(p: PolicyInput): string[] {
  const out: string[] = [];
  const ratio = (label: string, v: string) => { if (!NUMBER.test(v) || Number(v) > 10) out.push(`${label} must be a decimal from 0 to 10 (1 is 100%)`); };
  const positive = (label: string, v: string) => { if (!NUMBER.test(v) || Number(v) <= 0) out.push(`${label} must be a decimal above 0`); };
  ratio("default ratio", p.defaultRatio);
  if (!NUMBER.test(p.minHedgeDisplay)) out.push("minimum hedge amount must be a decimal of 0 or more");
  positive("default rounding", p.roundingDefault);
  if (!TENOR.test(p.tenor)) out.push('tenor must look like "1M" or "2W"');
  // The maximum hedge amount (decision 0016): in the display currency, above 0, and not below the minimum it would split into.
  const max = (label: string, v: string) => {
    if (!NUMBER.test(v) || Number(v) <= 0) out.push(`${label} must be a decimal above 0`);
    else if (NUMBER.test(p.minHedgeDisplay) && Number(v) < Number(p.minHedgeDisplay)) out.push(`${label} must not be below the minimum hedge amount`);
  };
  if (p.maxHedgeDisplay !== undefined && p.maxHedgeDisplay !== null) max("maximum hedge amount", p.maxHedgeDisplay);
  if (p.splitMethod !== undefined && !SPLIT_METHODS.includes(p.splitMethod)) out.push(`split method must be one of ${SPLIT_METHODS.join(", ")}`);
  const levels = new Set<string>();
  for (const o of p.maxHedgeOverrides ?? []) {
    if (!(NETTING_LEVELS as readonly string[]).includes(o.nettingLevel)) out.push(`maximum override level ${o.nettingLevel} must be one of ${NETTING_LEVELS.join(", ")}`);
    if (levels.has(o.nettingLevel)) out.push(`maximum override for ${o.nettingLevel} appears twice`);
    levels.add(o.nettingLevel);
    max(`maximum override ${o.nettingLevel}`, o.maxHedgeDisplay);
  }
  // The amount threshold (decision 0020): in the display currency and above 0. It may sit below the minimum hedge amount; the minimum then decides. The strategy needs it.
  const threshold = (label: string, v: string) => { if (!NUMBER.test(v) || Number(v) <= 0) out.push(`${label} must be a decimal above 0`); };
  if (p.strategy !== undefined && !STRATEGIES.includes(p.strategy)) out.push(`strategy must be one of ${STRATEGIES.join(", ")}`);
  if (p.amountThresholdDisplay !== undefined && p.amountThresholdDisplay !== null) threshold("amount threshold", p.amountThresholdDisplay);
  if (p.strategy === "amount-threshold" && (p.amountThresholdDisplay === undefined || p.amountThresholdDisplay === null)) out.push("the amount-threshold strategy needs an amount threshold");
  const thresholdLevels = new Set<string>();
  for (const o of p.amountThresholdOverrides ?? []) {
    if (!(NETTING_LEVELS as readonly string[]).includes(o.nettingLevel)) out.push(`amount threshold override level ${o.nettingLevel} must be one of ${NETTING_LEVELS.join(", ")}`);
    if (thresholdLevels.has(o.nettingLevel)) out.push(`amount threshold override for ${o.nettingLevel} appears twice`);
    thresholdLevels.add(o.nettingLevel);
    threshold(`amount threshold override ${o.nettingLevel}`, o.amountThresholdDisplay);
  }
  const pairs = new Set<string>();
  for (const o of p.ratioOverrides) {
    if (!/^[A-Z]{3}-[A-Z]{3}$/.test(o.pair)) out.push(`ratio override pair ${o.pair} must look like EUR-USD`);
    if (/^[A-Z]{3}-[A-Z]{3}$/.test(o.pair) && o.pair.slice(0, 3) === o.pair.slice(4)) out.push(`ratio override pair ${o.pair} has the same currency twice`);
    // EUR-USD and USD-EUR are the same pair: a ratio does not depend on which is written first.
    if (pairs.has(pairKey(o.pair))) out.push(`ratio override for ${o.pair} appears twice (EUR-USD and USD-EUR are the same pair)`);
    pairs.add(pairKey(o.pair));
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
      const before = await readPolicy(tx, input.tenantId, input.programId);
      await q(tx).deleteFrom("ratio_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).deleteFrom("rounding_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).deleteFrom("max_hedge_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).deleteFrom("amount_threshold_overrides").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      // The policy goes last: its overrides refer to it (decision 0018).
      await q(tx).deleteFrom("policies").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).execute();
      await q(tx).insertInto("policies").values({
        ...key, default_ratio: p.defaultRatio, min_hedge_display: p.minHedgeDisplay, rounding_default: p.roundingDefault, tenor: p.tenor,
        trading_entity_code: p.tradingEntityCode, max_hedge_display: p.maxHedgeDisplay ?? null, split_method: p.splitMethod ?? "EVEN", strategy: p.strategy ?? "hedge-ratio-adjustment", amount_threshold_display: p.amountThresholdDisplay ?? null, updated_by: who(input.actor), updated_at: clock(),
      }).execute();
      if (p.ratioOverrides.length > 0) await q(tx).insertInto("ratio_overrides").values(p.ratioOverrides.map((o) => ({ ...key, currency_pair: o.pair, ratio: o.ratio }))).execute();
      if (p.roundingOverrides.length > 0) await q(tx).insertInto("rounding_overrides").values(p.roundingOverrides.map((o) => ({ ...key, currency: o.currency, rounding: o.rounding }))).execute();
      if ((p.maxHedgeOverrides ?? []).length > 0) await q(tx).insertInto("max_hedge_overrides").values((p.maxHedgeOverrides ?? []).map((o) => ({ ...key, netting_level: o.nettingLevel, max_hedge_display: o.maxHedgeDisplay }))).execute();
      if ((p.amountThresholdOverrides ?? []).length > 0) await q(tx).insertInto("amount_threshold_overrides").values((p.amountThresholdOverrides ?? []).map((o) => ({ ...key, netting_level: o.nettingLevel, amount_threshold_display: o.amountThresholdDisplay }))).execute();
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const after = await readPolicy(tx, input.tenantId, input.programId);
      const fields = (["defaultRatio", "ratioOverrides", "minHedgeDisplay", "roundingDefault", "roundingOverrides", "tenor", "tradingEntityCode", "maxHedgeDisplay", "maxHedgeOverrides", "splitMethod", "strategy", "amountThresholdDisplay", "amountThresholdOverrides"] as const).filter((f) => !same(before[f], after[f]));
      await recordChange(tx, { tenantId: input.tenantId, programId: input.programId, actor: who(input.actor), action: "hedge-policy.set", targetType: "hedge-policy", targetId: input.programId, fields: before.saved ? fields : ["policy"] });
    });
  }
  return { setPolicy };
}
