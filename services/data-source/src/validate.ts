// Checks on one balance row that need no other service. Each problem blocks that balance, not the batch.
import { Decimal } from "decimal.js";
import type { GlBalanceRow } from "./rows.ts";

export const MAX_ROWS = 20_000;
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const SIGNED = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const UNSIGNED = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface RowIssue {
  readonly ruleCode: string;
  readonly description: string;
}

const blank = (v: string | null | undefined): v is null | undefined => v === null || v === undefined || v.trim() === "";

/** Fits NUMERIC(24,4): up to 20 digits before the point and 4 after. */
function fits(v: string): boolean {
  const [whole = "", frac = ""] = v.replace(/^[+-]/, "").split(".");
  return whole.replace(/^0+(?=\d)/, "").length <= 20 && frac.replace(/0+$/, "").length <= 4;
}

export interface AmountResult {
  readonly amount: string | null;
  readonly issues: RowIssue[];
}

/** The signed amount: a balance as given (its sign is not interpreted), or debit minus credit. */
export function normalizeAmount(row: Pick<GlBalanceRow, "balance" | "debit" | "credit">): AmountResult {
  const issues: RowIssue[] = [];
  const hasBalance = !blank(row.balance);
  const hasSide = !blank(row.debit) || !blank(row.credit);
  if (hasBalance && hasSide) return { amount: null, issues: [{ ruleCode: "GL_AMOUNT_CONFLICT", description: "Send a balance or debit and credit amounts, not both" }] };
  if (!hasBalance && !hasSide) return { amount: null, issues: [{ ruleCode: "GL_AMOUNT_MISSING", description: "A balance, or a debit or credit amount, is required" }] };
  const bad = (what: string) => issues.push({ ruleCode: "GL_AMOUNT_INVALID", description: `${what} must be a number with at most 4 places` });
  if (hasBalance) {
    if (!SIGNED.test(row.balance!) || !fits(row.balance!)) {
      bad("Balance");
      return { amount: null, issues };
    }
    return { amount: new Decimal(row.balance!).toFixed(4), issues };
  }
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const [label, v] of [["Debit", row.debit], ["Credit", row.credit]] as const) {
    if (blank(v)) continue;
    if (!UNSIGNED.test(v) || !fits(v)) bad(label);
    else if (label === "Debit") debit = new Decimal(v);
    else credit = new Decimal(v);
  }
  return issues.length > 0 ? { amount: null, issues } : { amount: debit.minus(credit).toFixed(4), issues };
}

/** The identity of a balance within a batch: entity, account, currency and dimension values. */
export function recordKey(row: Pick<GlBalanceRow, "entityCode" | "accountNumber" | "currency" | "dimensions">): string {
  const dims = Object.entries(row.dimensions)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return `${row.entityCode ?? ""}|${row.accountNumber ?? ""}|${row.currency ?? ""}|${dims}`;
}

export function checkRow(row: GlBalanceRow, batchAsOf: string): { amount: string | null; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  if (blank(row.entityCode)) issues.push({ ruleCode: "GL_ENTITY_MISSING", description: "Entity code is required" });
  if (blank(row.accountNumber)) issues.push({ ruleCode: "GL_ACCOUNT_MISSING", description: "Account number is required" });
  if (blank(row.currency)) issues.push({ ruleCode: "GL_CURRENCY_MISSING", description: "Currency is required" });
  else if (!/^[A-Z]{3}$/.test(row.currency) || !CURRENCIES.has(row.currency)) {
    issues.push({ ruleCode: "GL_CURRENCY_UNSUPPORTED", description: `Currency ${row.currency} is not a supported 3-letter code` });
  }
  if (row.asOf !== null && row.asOf !== batchAsOf) issues.push({ ruleCode: "GL_AS_OF_MISMATCH", description: `Row as-of date ${row.asOf} differs from the batch's ${batchAsOf}` });
  const a = normalizeAmount(row);
  issues.push(...a.issues);
  return { amount: a.amount, issues };
}
