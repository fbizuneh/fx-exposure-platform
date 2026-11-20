// The calculation, with no I/O: filter, baseline, netting level, gross exposure (decision 0008).
import { Decimal as Dec } from "decimal.js";
import type { IncludedBalance } from "@services/data-source/contract";
import type { Account, Entity } from "@services/master-data/contract";
import type { NettingLevel } from "@services/exposure-management/contract";
import type { ExecutedTrade } from "@services/fx-trade/contract";
import type { FilterCounts, HedgeCounts } from "../contract/index.ts";

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

/** What netting needs from a row, whether it came from a balance or from a hedge leg. */
export interface NetRow {
  readonly rowNo: number;
  readonly entityCode: string;
  readonly region: string;
  readonly currency1: string;
  readonly currency2: string;
  readonly amount1: Num;
  readonly amount2: Num;
  /** The entity's functional currency; empty if it has none. */
  readonly functional: string;
  /** Hedge rows only: the deal currency of the trade leg, the exposure currency when the entity's functional currency is not in the pair. */
  readonly dealCurrency?: string;
}
/** An open leg of an executed trade (decision 0010). */
export interface HedgeRow extends NetRow {
  readonly executedTradeId: string;
  readonly platform: string;
  readonly tradeId: string;
  readonly legNo: number;
  readonly dealCurrency: string;
  readonly settlementCurrency: string;
  readonly pair: string;
  /** When the leg matures. */
  readonly valueDate: string;
}
const flat = (r: Baseline | NetRow): NetRow =>
  "kept" in r ? { rowNo: r.rowNo, entityCode: r.kept.balance.entityCode, region: r.region, currency1: r.kept.currency1, currency2: r.kept.currency2, amount1: r.amount1, amount2: r.amount2, functional: r.kept.functionalCurrency } : r;

/**
 * Hedge rows from executed trades (decision 0010): one per leg whose value date is after the as-of date. Buying the deal currency is
 * positive in it and negative in the settlement currency; selling is the reverse. Both amounts are rounded to 2 places.
 * `entityOf` returns the trading entity's region and functional currency, or null when Master Data does not know it.
 */
export function buildHedgeRows(
  trades: readonly ExecutedTrade[], asOf: string, entityOf: (code: string) => { readonly region: string; readonly functional: string } | null,
): { readonly rows: HedgeRow[]; readonly counts: HedgeCounts } {
  const rows: HedgeRow[] = [];
  let openLegs = 0, noEntity = 0;
  const excluded: HedgeCounts["excluded"][number][] = [];
  for (const t of trades) {
    for (const leg of t.legs) {
      if (leg.valueDate <= asOf) continue;
      openLegs++;
      const info = entityOf(t.tradingEntityCode);
      if (!info) {
        noEntity++;
        excluded.push({ executedTradeId: t.executedTradeId, platform: t.platform, tradeId: t.tradeId, legNo: leg.legNo, entityCode: t.tradingEntityCode, reason: "TRADING_ENTITY_NOT_ON_RECORD" });
        continue;
      }
      const deal = new D(leg.dealAmount), settle = new D(leg.settlementAmount);
      const [dealSigned, settleSigned] = leg.direction === "BUY" ? [deal, settle.negated()] : [deal.negated(), settle];
      const [c1, c2] = orderPair(leg.dealCurrency, leg.settlementCurrency);
      const dealIs1 = leg.dealCurrency === c1;
      const a1 = round2(dealIs1 ? dealSigned : settleSigned), a2 = round2(dealIs1 ? settleSigned : dealSigned);
      rows.push({
        rowNo: rows.length + 1, entityCode: t.tradingEntityCode, region: info.region, currency1: c1, currency2: c2, amount1: a1, amount2: a2, functional: info.functional,
        executedTradeId: t.executedTradeId, platform: t.platform, tradeId: t.tradeId, legNo: leg.legNo, dealCurrency: leg.dealCurrency, settlementCurrency: leg.settlementCurrency, pair: pairName(c1, c2), valueDate: leg.valueDate,
      });
    }
  }
  return { rows, counts: { trades: trades.length, openLegs, used: rows.length, noEntity, excluded } };
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
  /** The entity's functional currency; empty when the contribution is a portfolio re-pairing. */
  readonly functional: string;
  readonly dealCurrency?: string;
}

const straight = (rows: readonly NetRow[]): Contribution[] =>
  rows.map((r) => ({ rowNo: r.rowNo, entityCode: r.entityCode, region: r.region, currency1: r.currency1, currency2: r.currency2, amount1: r.amount1, amount2: r.amount2, functional: r.functional, ...(r.dealCurrency === undefined ? {} : { dealCurrency: r.dealCurrency }) }));

/** Re-express every row against the portfolio currency: each non-portfolio currency leg is paired with it. */
export function repairToPortfolio(input: readonly (Baseline | NetRow)[], portfolio: string, rateToPortfolio: (ccy: string) => string): Contribution[] {
  const out: Contribution[] = [];
  for (const r of input.map(flat)) {
    const legs = [
      { ccy: r.currency1, amount: r.amount1, otherCcy: r.currency2, otherAmount: r.amount2 },
      { ccy: r.currency2, amount: r.amount2, otherCcy: r.currency1, otherAmount: r.amount1 },
    ];
    for (const l of legs) {
      if (l.ccy === portfolio) continue;
      const offset = l.otherCcy === portfolio ? l.otherAmount : round2(l.amount.times(rateToPortfolio(l.ccy))).negated();
      const [c1, c2] = orderPair(l.ccy, portfolio);
      const clean = offset.isZero() ? new D(0) : offset;
      out.push({
        rowNo: r.rowNo, entityCode: r.entityCode, region: r.region, currency1: c1, currency2: c2,
        amount1: c1 === l.ccy ? l.amount : clean, amount2: c1 === l.ccy ? clean : l.amount, functional: "",
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

/** The order in which a major currency decides the exposure currency of a pair that holds it: the other currency is exposed. */
const MAJORS = ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "SGD"] as const;

/**
 * The default exposure currency of a pair (decision 0008): the NDF currency if the pair has one (currency 2 if both are NDF);
 * otherwise the other currency of the first major (USD, EUR, GBP, AUD, NZD, CAD, CHF, SGD) the pair holds; otherwise currency 2.
 */
export function defaultExposureCurrency(c1: string, c2: string, ndf: ReadonlySet<string>): string {
  const [n1, n2] = [ndf.has(c1), ndf.has(c2)];
  if (n1 !== n2) return n1 ? c1 : c2;
  if (n1 && n2) return c2;
  for (const m of MAJORS) {
    if (c1 === m) return c2;
    if (c2 === m) return c1;
  }
  return c2;
}

export interface ExposureCurrencyRules {
  readonly ndf: ReadonlySet<string>;
  /** Per program, keyed by the pair's two codes in alphabetical order, as `overrideKey` makes it. */
  readonly overrides: ReadonlyMap<string, string>;
}
export const overrideKey = (a: string, b: string): string => [a, b].sort().join("-");

/**
 * A group's exposure currency, in this order (a pair without the entity's functional currency skips step 2):
 * 1. portfolio level: always the non-portfolio currency;
 * 2. a netting level with an entity in it (region by entity, entity): always the entity's non-functional currency;
 * 3. the program's override for the pair;
 * 4. the default logic (NDF, then the majors, then currency 2).
 * Steps 1 and 2 are fixed: no override applies. `functional` is the functional currency of the group's entity.
 */
export function exposureCurrencyFor(level: NettingLevel, c1: string, c2: string, display: string, rules: ExposureCurrencyRules, functional: string | null = null): string {
  if (level === "GROUP_PORTFOLIO") return c1 === display ? c2 : c1;
  if (byEntity(level) && functional !== null && (c1 === functional || c2 === functional)) return c1 === functional ? c2 : c1;
  return rules.overrides.get(overrideKey(c1, c2)) ?? defaultExposureCurrency(c1, c2, rules.ndf);
}

export function netByLevel(
  rows: readonly (Baseline | NetRow)[], level: NettingLevel, period: string, display: string, rateOf: (base: string, quote: string) => string,
  exposureRules: ExposureCurrencyRules = { ndf: new Set(), overrides: new Map() },
): GroupResult[] {
  const contributions = level === "GROUP_PORTFOLIO" ? repairToPortfolio(rows, display, (ccy) => rateOf(ccy, display)) : straight(rows.map(flat));
  // The exposure currency is chosen per contribution, before aggregation, and is part of the netting key (decision 0010).
  const exposureOf = (c: Contribution): string => {
    const fn = c.functional === "" ? null : c.functional;
    if (byEntity(level) && c.dealCurrency !== undefined && (fn === null || (c.currency1 !== fn && c.currency2 !== fn))) {
      // Hedge without the functional currency in the pair: the program's override for the pair if it has one, else the deal currency. No default ranking.
      const o = exposureRules.overrides.get(overrideKey(c.currency1, c.currency2));
      return o !== undefined && (o === c.currency1 || o === c.currency2) ? o : c.dealCurrency;
    }
    return exposureCurrencyFor(level, c.currency1, c.currency2, display, exposureRules, fn);
  };
  const groups = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const key = [byRegion(level) ? c.region : "", byEntity(level) ? c.entityCode : "", pairName(c.currency1, c.currency2), exposureOf(c)].join("\u0000");
    const list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  }
  const results: GroupResult[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const sum = (f: (c: Contribution) => Num, keep: (n: Num) => boolean = () => true) => list.map(f).filter(keep).reduce((a, b) => a.plus(b), new D(0));
    const net1 = sum((c) => c.amount1), net2 = sum((c) => c.amount2);
    const exposureCurrency = exposureOf(first);
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
  return results.sort((a, b) => cmp(a.pair, b.pair) || cmp(a.region, b.region) || cmp(a.entityCode, b.entityCode) || cmp(a.exposureCurrency, b.exposureCurrency));
}

export interface RateNeed { readonly base: string; readonly quote: string; readonly purpose: "PAIR" | "DISPLAY" | "PORTFOLIO" }

/** Every rate the run needs, known before any is fetched, so a missing one stops the run before it starts. */
export function requiredRates(kept: readonly Kept[], level: NettingLevel, display: string, hedges: readonly { readonly currency1: string; readonly currency2: string }[] = []): RateNeed[] {
  const needs = new Map<string, RateNeed>();
  const add = (base: string, quote: string, purpose: RateNeed["purpose"]) => {
    if (base !== quote) needs.set(`${base}|${quote}|${purpose}`, { base, quote, purpose });
  };
  for (const k of kept) {
    add(k.currency1, k.currency2, "PAIR");
    if (level === "GROUP_PORTFOLIO") { add(k.currency1, display, "PORTFOLIO"); add(k.currency2, display, "PORTFOLIO"); }
    else add(k.currency1, display, "DISPLAY");
  }
  // A hedge pair needs only the rates that express it in the display currency; its own amounts are the traded ones.
  for (const h of hedges) {
    if (level === "GROUP_PORTFOLIO") { add(h.currency1, display, "PORTFOLIO"); add(h.currency2, display, "PORTFOLIO"); }
    else add(h.currency1, display, "DISPLAY");
  }
  return [...needs.values()].sort((a, b) => `${a.base}${a.quote}${a.purpose}`.localeCompare(`${b.base}${b.quote}${b.purpose}`));
}

export interface NetGroupResult {
  readonly group: GroupResult;
  readonly gross: { readonly net1: Num; readonly net2: Num; readonly exposure: Num; readonly display: Num };
  readonly hedges: { readonly net1: Num; readonly net2: Num; readonly exposure: Num; readonly display: Num };
  readonly net: { readonly net1: Num; readonly net2: Num; readonly exposure: Num; readonly display: Num };
}

const groupKey = (g: GroupResult): string => [g.region ?? "", g.entityCode ?? "", g.pair, g.exposureCurrency].join("\u0000");

/**
 * Net exposure per group (decision 0010): the same netting over balances and hedge rows. Hedges are net minus gross, so the three add up.
 * A group that exists only because of a hedge has zero gross.
 */
export function netExposure(
  baseline: readonly Baseline[], hedgeRows: readonly HedgeRow[], level: NettingLevel, period: string, display: string, rateOf: (base: string, quote: string) => string,
  exposureRules: ExposureCurrencyRules, gross: readonly GroupResult[],
): NetGroupResult[] {
  const all = netByLevel([...baseline, ...hedgeRows], level, period, display, rateOf, exposureRules);
  const grossBy = new Map(gross.map((g) => [groupKey(g), g]));
  return all.map((n) => {
    const g = grossBy.get(groupKey(n));
    const g1 = g?.net1 ?? new D(0), g2 = g?.net2 ?? new D(0), ge = g?.exposureAmount ?? new D(0), gd = g?.displayAmount ?? new D(0);
    const rate = n.displayRate;
    const h1 = round2(n.net1.minus(g1)), h2 = round2(n.net2.minus(g2)), he = round2(n.exposureAmount.minus(ge));
    const zero = (x: Num): Num => (x.isZero() ? new D(0) : x);
    return {
      group: n,
      gross: { net1: g1, net2: g2, exposure: ge, display: gd },
      hedges: { net1: zero(h1), net2: zero(h2), exposure: zero(he), display: round2(h1.times(rate)) },
      net: { net1: n.net1, net2: n.net2, exposure: n.exposureAmount, display: n.displayAmount },
    };
  });
}

/**
 * Where each hedge row fell (decision 0021): the net group it belongs to (1-based, in the order of `net`) and its amount in that group's exposure currency.
 * A group's key comes from each contribution alone, so netting the hedge rows by themselves gives the same keys as netting them with the balances.
 */
export function hedgeRowPlacement(
  hedgeRows: readonly HedgeRow[], level: NettingLevel, period: string, display: string, rateOf: (base: string, quote: string) => string,
  exposureRules: ExposureCurrencyRules, net: readonly NetGroupResult[],
): Map<number, { readonly groupNo: number; readonly exposureAmount: Num }> {
  const index = new Map(net.map((n, i) => [groupKey(n.group), i + 1] as const));
  const out = new Map<number, { groupNo: number; exposureAmount: Num }>();
  for (const g of netByLevel(hedgeRows, level, period, display, rateOf, exposureRules)) {
    const groupNo = index.get(groupKey(g));
    if (groupNo === undefined) continue;
    for (const m of g.members) {
      const amount = g.exposureCurrency === g.currency1 ? m.amount1 : m.amount2;
      const have = out.get(m.rowNo);
      out.set(m.rowNo, { groupNo, exposureAmount: (have?.exposureAmount ?? new D(0)).plus(amount) });
    }
  }
  return out;
}
