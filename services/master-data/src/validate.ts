// Checks a change set before anything is written. Pure: the caller passes in what already exists.
import { ENTITY_TYPES, HIERARCHY_CLASSIFICATIONS, NORMAL_BALANCES, STATEMENT_TYPES } from "../contract/index.ts";
import { chartKey, type AccountRow, type CurrencyRow, type EntityRow, type HierarchyNodeRow, type Mode } from "./rows.ts";
import { findCycle } from "./tree.ts";

const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const blank = (s: unknown) => typeof s !== "string" || s.trim() === "" || s !== s.trim();
const has = <T extends string>(list: readonly T[], v: unknown) => (list as readonly unknown[]).includes(v);

export class ChangeSetInvalid extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`change set is invalid: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}`);
    this.problems = problems;
  }
}

function duplicates(keys: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) out.push(`${label} ${k} appears twice`);
    seen.add(k);
  }
  return out;
}

/** The parent map after the change set is applied: a snapshot is the whole picture, a partial one adds to it. */
function finalParents(incoming: Map<string, string | null>, existing: ReadonlyMap<string, string | null>, mode: Mode) {
  return mode === "SNAPSHOT" ? incoming : new Map([...existing, ...incoming]);
}

function checkParents(label: string, incoming: Map<string, string | null>, existing: ReadonlyMap<string, string | null>, mode: Mode, show: (k: string) => string): string[] {
  const out: string[] = [];
  const final = finalParents(incoming, existing, mode);
  for (const [k, parent] of incoming) {
    if (parent !== null && !final.has(parent)) out.push(`${label} ${show(k)} has unknown parent ${show(parent)}`);
  }
  const cyc = findCycle(final);
  if (cyc !== null) out.push(`${label} ${show(cyc)} sits on a parent cycle`);
  return out;
}

export function validateEntities(rows: readonly EntityRow[], existingParents: ReadonlyMap<string, string | null>, mode: Mode): string[] {
  const out = duplicates(rows.map((r) => r.code), "entity");
  for (const r of rows) {
    const at = `entity ${r.code}`;
    if (blank(r.code) || blank(r.name)) out.push(`${at}: code and name are required, without surrounding spaces`);
    if (!has(ENTITY_TYPES, r.type)) out.push(`${at}: unknown type ${String(r.type)}`);
    if (r.countryCode !== null && !COUNTRY.test(r.countryCode)) out.push(`${at}: country code must be two capital letters`);
    if (r.functionalCurrency !== null && !CURRENCY.test(r.functionalCurrency)) out.push(`${at}: currency must be three capital letters`);
    if ((r.isLegalEntity || r.type === "LEGAL_ENTITY") && r.functionalCurrency === null) out.push(`${at}: a legal entity needs a functional currency`);
  }
  const incoming = new Map(rows.map((r) => [r.code, r.parentCode] as const));
  return [...out, ...checkParents("entity", incoming, existingParents, mode, (k) => k)];
}

export function validateHierarchy(rows: readonly HierarchyNodeRow[], existingParents: ReadonlyMap<string, string | null>, mode: Mode): string[] {
  const out = duplicates(rows.map((r) => chartKey(r.chartCode, r.code)), "hierarchy node");
  for (const r of rows) {
    const at = `hierarchy node ${r.chartCode}/${r.code}`;
    if (blank(r.chartCode) || blank(r.code) || blank(r.name)) out.push(`${at}: chart, code and name are required, without surrounding spaces`);
    if (!has(HIERARCHY_CLASSIFICATIONS, r.classification)) out.push(`${at}: unknown classification ${String(r.classification)}`);
  }
  const incoming = new Map(rows.map((r) => [chartKey(r.chartCode, r.code), r.parentCode === null ? null : chartKey(r.chartCode, r.parentCode)] as const));
  const show = (k: string) => (JSON.parse(k) as string[]).join("/");
  return [...out, ...checkParents("hierarchy node", incoming, existingParents, mode, show)];
}

/** `knownNodes` holds the chartKey of every hierarchy node valid on the date; accounts attach only to those. */
export function validateAccounts(rows: readonly AccountRow[], knownNodes: ReadonlySet<string>): string[] {
  const out = duplicates(rows.map((r) => chartKey(r.chartCode, r.accountNumber)), "account");
  for (const r of rows) {
    const at = `account ${r.chartCode}/${r.accountNumber}`;
    if (blank(r.chartCode) || blank(r.accountNumber) || blank(r.name)) out.push(`${at}: chart, number and name are required, without surrounding spaces`);
    if (!has(STATEMENT_TYPES, r.statementType)) out.push(`${at}: unknown statement type ${String(r.statementType)}`);
    if (!has(NORMAL_BALANCES, r.normalBalance)) out.push(`${at}: unknown normal balance ${String(r.normalBalance)}`);
    if (typeof r.monetaryFlag !== "boolean" || typeof r.fxRelevantFlag !== "boolean") out.push(`${at}: monetary and FX-relevant flags must be true or false`);
    if (r.hierarchyNodeCode !== null && !knownNodes.has(chartKey(r.chartCode, r.hierarchyNodeCode))) {
      out.push(`${at}: hierarchy node ${r.hierarchyNodeCode} does not exist in chart ${r.chartCode}`);
    }
  }
  return out;
}

export function validateCurrencies(rows: readonly CurrencyRow[]): string[] {
  const out = duplicates(rows.map((r) => r.code), "currency");
  for (const r of rows) {
    if (typeof r.code !== "string" || !CURRENCY.test(r.code)) out.push(`currency ${String(r.code)}: code must be three capital letters`);
    if (typeof r.isNdf !== "boolean") out.push(`currency ${String(r.code)}: NDF must be true or false`);
  }
  return out;
}
