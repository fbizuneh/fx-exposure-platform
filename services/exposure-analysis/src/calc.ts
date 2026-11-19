// The calculation, with no I/O: filter, baseline, netting level, gross exposure (decision 0008).
import { Decimal as Dec } from "decimal.js";
import type { IncludedBalance } from "@services/data-source/contract";
import type { Account, Entity } from "@services/master-data/contract";
import type { NettingLevel } from "@services/exposure-management/contract";
import type { FilterCounts } from "../contract/index.ts";

const D = Dec.clone({ precision: 40, rounding: Dec.ROUND_HALF_UP });
type Num = InstanceType<typeof D>;

/** Two places, half away from zero, as the workbook rounds; never a negative zero. */
export const round2 = (n: Num): Num => {
  const r = n.toDecimalPlaces(2, D.ROUND_HALF_UP);
  return r.isZero() ? new D(0) : r;
};
export const fixed4 = (n: Num): string => (n.isZero() ? new D(0) : n).toFixed(4);

const CONVENTION = ["EUR", "GBP", "AUD", "NZD", "USD", "CHF", "CAD", "SGD"] as const;
const rank = (c: string): number => {
  const i = (CONVENTION as readonly string[]).indexOf(c);
  return i === -1 ? CONVENTION.length : i;
};
/** Market convention: the currency earlier in EUR, GBP, AUD, NZD, USD, CHF, CAD, SGD is currency 1; others follow alphabetically. */
export function orderPair(a: string, b: string): readonly [string, string] {
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? [a, b] : [b, a];
  return a <= b ? [a, b] : [b, a];
}

export const accountKey = (chartCode: string, accountNumber: string): string => `${chartCode}\u0000${accountNumber}`;

export interface Kept {
  readonly balance: IncludedBalance;
  readonly entity: Entity;
  readonly functionalCurrency: string;
  readonly currency1: string;
  readonly currency2: string;
}

/** Legal entities, FX-relevant and monetary accounts, and balances not in the functional currency. */
export function filterBalances(
  balances: readonly IncludedBalance[],
  entities: ReadonlyMap<string, Entity>,
  accounts: ReadonlyMap<string, Account>,
): { readonly kept: readonly Kept[]; readonly counts: FilterCounts } {
  let notLegalEntity = 0, accountNotInScope = 0, functionalCurrency = 0, noFunctionalCurrency = 0;
  const kept: Kept[] = [];
  for (const b of balances) {
    const entity = entities.get(b.entityCode);
    if (!entity || !entity.isLegalEntity) { notLegalEntity++; continue; }
    const account = accounts.get(accountKey(b.chartCode, b.accountNumber));
    if (!account || !account.fxRelevantFlag || !account.monetaryFlag) { accountNotInScope++; continue; }
    if (entity.functionalCurrency === null) { noFunctionalCurrency++; continue; }
    if (entity.functionalCurrency === b.currency) { functionalCurrency++; continue; }
    const [currency1, currency2] = orderPair(b.currency, entity.functionalCurrency);
    kept.push({ balance: b, entity, functionalCurrency: entity.functionalCurrency, currency1, currency2 });
  }
  return { kept, counts: { received: balances.length, kept: kept.length, notLegalEntity, accountNotInScope, functionalCurrency, noFunctionalCurrency } };
}

export interface Baseline {
  readonly rowNo: number;
  readonly kept: Kept;
  readonly region: string;
  readonly pair: string;
  readonly rate: string;
  /** The balance as sent, and its two legs: opposite in sign, the other leg rounded to 2 places. */
  readonly amount: Num;
  readonly amount1: Num;
  readonly amount2: Num;
}

export const pairName = (c1: string, c2: string): string => `${c1}-${c2}`;

/** `rateOf(c1, c2)`: units of c2 per unit of c1. `regionOf(entityCode)` is the entity's region. */
export function buildBaseline(kept: readonly Kept[], rateOf: (c1: string, c2: string) => string, regionOf: (entityCode: string) => string): Baseline[] {
  return kept.map((k, i) => {
    const rate = rateOf(k.currency1, k.currency2);
    const amount = new D(k.balance.amount);
    // Functional currency is currency 1: divide by the rate; currency 2: multiply by it. The other leg is opposite in sign.
    const converted = k.functionalCurrency === k.currency1 ? amount.div(rate) : amount.times(rate);
    const other = round2(converted).negated();
    const txIs1 = k.balance.currency === k.currency1;
    return {
      rowNo: i + 1, kept: k, region: regionOf(k.balance.entityCode), pair: pairName(k.currency1, k.currency2), rate, amount,
      amount1: txIs1 ? amount : (other.isZero() ? new D(0) : other), amount2: txIs1 ? (other.isZero() ? new D(0) : other) : amount,
    };
  });
}

/** One contribution to a netting group. At the portfolio level a baseline row gives up to two. */
export interface Contribution {
  readonly rowNo: number;
  readonly entityCode: string;
  readonly region: string;
  readonly currency1: string;
  readonly currency2: string;
  readonly amount1: Num;
  readonly amount2: Num;
}

const straight = (rows: readonly Baseline[]): Contribution[] =>
  rows.map((r) => ({ rowNo: r.rowNo, entityCode: r.kept.balance.entityCode, region: r.region, currency1: r.kept.currency1, currency2: r.kept.currency2, amount1: r.amount1, amount2: r.amount2 }));

/** Re-express every row against the portfolio currency: each non-portfolio currency leg is paired with it. */
export function repairToPortfolio(rows: readonly Baseline[], portfolio: string, rateToPortfolio: (ccy: string) => string): Contribution[] {
  const out: Contribution[] = [];
  for (const r of rows) {
    const legs = [
      { ccy: r.kept.currency1, amount: r.amount1, otherCcy: r.kept.currency2, otherAmount: r.amount2 },
      { ccy: r.kept.currency2, amount: r.amount2, otherCcy: r.kept.currency1, otherAmount: r.amount1 },
    ];
    for (const l of legs) {
      if (l.ccy === portfolio) continue;
      const offset = l.otherCcy === portfolio ? l.otherAmount : round2(l.amount.times(rateToPortfolio(l.ccy))).negated();
      const [c1, c2] = orderPair(l.ccy, portfolio);
      const clean = offset.isZero() ? new D(0) : offset;
      out.push({
        rowNo: r.rowNo, entityCode: r.kept.balance.entityCode, region: r.region, currency1: c1, currency2: c2,
        amount1: c1 === l.ccy ? l.amount : clean, amount2: c1 === l.ccy ? clean : l.amount,
      });
    }
  }
  return out;
}

export interface GroupResult {
  readonly nettingLevel: NettingLevel;
  readonly region: string | null;
  readonly entityCode: string | null;
  readonly currency1: string;
  readonly currency2: string;
  readonly pair: string;
  readonly exposureCurrency: string;
  readonly period: string;
  readonly members: readonly { readonly rowNo: number; readonly amount1: Num; readonly amount2: Num }[];
  readonly long1: Num;
  readonly short1: Num;
  readonly net1: Num;
  readonly net2: Num;
  readonly exposureAmount: Num;
  readonly displayRate: string;
  readonly displayAmount: Num;
}

const byRegion = (l: NettingLevel): boolean => l === "REGION" || l === "REGION_BY_ENTITY";
const byEntity = (l: NettingLevel): boolean => l === "REGION_BY_ENTITY" || l === "ENTITY";

/** The exposure currency: the one that is not the display currency when the pair holds it, otherwise currency 2. */
export function exposureCurrencyOf(c1: string, c2: string, display: string): string {
  return c1 === display ? c2 : c2 === display ? c1 : c2;
}

export function netByLevel(
  rows: readonly Baseline[], level: NettingLevel, period: string, display: string, rateOf: (base: string, quote: string) => string,
): GroupResult[] {
  const contributions = level === "GROUP_PORTFOLIO" ? repairToPortfolio(rows, display, (ccy) => rateOf(ccy, display)) : straight(rows);
  const groups = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const key = [byRegion(level) ? c.region : "", byEntity(level) ? c.entityCode : "", pairName(c.currency1, c.currency2)].join("\u0000");
    const list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  }
  const results: GroupResult[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const sum = (f: (c: Contribution) => Num, keep: (n: Num) => boolean = () => true) => list.map(f).filter(keep).reduce((a, b) => a.plus(b), new D(0));
    const net1 = sum((c) => c.amount1), net2 = sum((c) => c.amount2);
    const exposureCurrency = exposureCurrencyOf(first.currency1, first.currency2, display);
    const displayRate = first.currency1 === display ? "1" : rateOf(first.currency1, display);
    results.push({
      nettingLevel: level, region: byRegion(level) ? first.region : null, entityCode: byEntity(level) ? first.entityCode : null,
      currency1: first.currency1, currency2: first.currency2, pair: pairName(first.currency1, first.currency2), exposureCurrency, period,
      members: list.map((c) => ({ rowNo: c.rowNo, amount1: c.amount1, amount2: c.amount2 })),
      long1: sum((c) => c.amount1, (n) => n.gt(0)), short1: sum((c) => c.amount1, (n) => n.lt(0)), net1, net2,
      exposureAmount: exposureCurrency === first.currency1 ? net1 : net2, displayRate, displayAmount: round2(net1.times(displayRate)),
    });
  }
  const cmp = (a: string | null, b: string | null) => (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;
  return results.sort((a, b) => cmp(a.pair, b.pair) || cmp(a.region, b.region) || cmp(a.entityCode, b.entityCode));
}

export interface RateNeed { readonly base: string; readonly quote: string; readonly purpose: "PAIR" | "DISPLAY" | "PORTFOLIO" }

/** Every rate the run needs, known before any is fetched, so a missing one stops the run before it starts. */
export function requiredRates(kept: readonly Kept[], level: NettingLevel, display: string): RateNeed[] {
  const needs = new Map<string, RateNeed>();
  const add = (base: string, quote: string, purpose: RateNeed["purpose"]) => {
    if (base !== quote) needs.set(`${base}|${quote}|${purpose}`, { base, quote, purpose });
  };
  for (const k of kept) {
    add(k.currency1, k.currency2, "PAIR");
    if (level === "GROUP_PORTFOLIO") { add(k.currency1, display, "PORTFOLIO"); add(k.currency2, display, "PORTFOLIO"); }
    else add(k.currency1, display, "DISPLAY");
  }
  return [...needs.values()].sort((a, b) => `${a.base}${a.quote}${a.purpose}`.localeCompare(`${b.base}${b.quote}${b.purpose}`));
}
