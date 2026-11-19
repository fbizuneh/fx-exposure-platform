// Pure program matching. No I/O, no clock. A rule matches an account or a hierarchy node (the node and all below it),
// narrowed by source system, entity and dimensions. An absent narrowing matches anything.
import type { MappingRule } from "./rows.ts";

export interface MatchFact {
  readonly chartCode: string;
  readonly accountNumber: string;
  /** The account's node code, then its ancestors, nearest first. Empty when the account is on no node. */
  readonly hierarchyPath: readonly string[];
  readonly entityCode: string;
  readonly sourceSystem: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly asOf: string;
}

export type MatchOutcome = "ASSIGNED" | "EXCLUDED" | "UNMATCHED" | "MULTI_MATCH";

export interface MatchResult {
  readonly outcome: MatchOutcome;
  /** Set only for ASSIGNED. */
  readonly programId: string | null;
  readonly claimingPrograms: readonly string[];
  readonly matchedRuleIds: readonly string[];
}

export const isActive = (r: MappingRule, date: string): boolean => r.validFrom <= date && (r.validTo === null || date < r.validTo);

export function ruleMatches(rule: MappingRule, fact: MatchFact): boolean {
  if (!isActive(rule, fact.asOf)) return false;
  if (rule.sourceSystem !== null && rule.sourceSystem !== fact.sourceSystem) return false;
  if (rule.entityCode !== null && rule.entityCode !== fact.entityCode) return false;
  if (rule.dimensions) {
    for (const [name, values] of Object.entries(rule.dimensions)) {
      const actual = fact.dimensions[name];
      if (actual === undefined || !values.includes(actual)) return false;
    }
  }
  if (rule.target.chartCode !== fact.chartCode) return false;
  return rule.target.type === "ACCOUNT" ? rule.target.accountNumber === fact.accountNumber : fact.hierarchyPath.includes(rule.target.nodeCode);
}

export function matchProgram(rules: readonly MappingRule[], fact: MatchFact): MatchResult {
  const matched = rules.filter((r) => ruleMatches(r, fact));
  const programs = [...new Set(matched.map((r) => r.programId))].sort();
  const claiming: string[] = [];
  const excluded: string[] = [];
  const decisive: string[] = [];
  for (const p of programs) {
    const mine = matched.filter((r) => r.programId === p);
    const includes = mine.filter((r) => r.kind === "INCLUDE");
    const excludes = mine.filter((r) => r.kind === "EXCLUDE");
    if (includes.length === 0) continue; // an exclude with nothing to remove does nothing
    if (excludes.length > 0) {
      excluded.push(p);
      decisive.push(...excludes.map((r) => r.ruleId));
    } else {
      claiming.push(p);
      decisive.push(...includes.map((r) => r.ruleId));
    }
  }
  if (claiming.length > 1) return { outcome: "MULTI_MATCH", programId: null, claimingPrograms: claiming, matchedRuleIds: decisive };
  if (claiming.length === 1) return { outcome: "ASSIGNED", programId: claiming[0]!, claimingPrograms: claiming, matchedRuleIds: decisive };
  if (excluded.length > 0) return { outcome: "EXCLUDED", programId: null, claimingPrograms: [], matchedRuleIds: decisive };
  return { outcome: "UNMATCHED", programId: null, claimingPrograms: [], matchedRuleIds: [] };
}

/** Can one balance fall under both rules' scopes? False only when the scopes cannot meet. */
export function scopesMeet(a: MappingRule, b: MappingRule): boolean {
  if (a.sourceSystem !== null && b.sourceSystem !== null && a.sourceSystem !== b.sourceSystem) return false;
  if (a.entityCode !== null && b.entityCode !== null && a.entityCode !== b.entityCode) return false;
  if (a.dimensions && b.dimensions) {
    for (const [name, av] of Object.entries(a.dimensions)) {
      const bv = b.dimensions[name];
      if (bv && !av.some((v) => bv.includes(v))) return false;
    }
  }
  return true;
}

/** The first date on which both rules apply, or null when their dates never overlap. */
export function firstSharedDate(a: MappingRule, b: MappingRule): string | null {
  const from = a.validFrom > b.validFrom ? a.validFrom : b.validFrom;
  const aEnd = a.validTo ?? "9999-12-31";
  const bEnd = b.validTo ?? "9999-12-31";
  const to = aEnd < bEnd ? aEnd : bEnd;
  return from < to ? from : null;
}
