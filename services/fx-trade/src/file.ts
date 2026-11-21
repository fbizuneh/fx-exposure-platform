// The standard flat file, both ways: executed trades in, pre-trades out. Plain text in, plain rows out.
import type { Instrument } from "../contract/index.ts";

/** One row of the executed-trade file as received. Everything is text; nothing is trusted yet. */
export interface ExecutedRow {
  readonly rowNo: number;
  readonly tradeId: string | null;
  readonly platform: string | null;
  readonly tradingEntity: string | null;
  readonly counterparty: string | null;
  readonly tradeDate: string | null;
  readonly valueDate: string | null;
  readonly dealCurrency: string | null;
  readonly dealAmount: string | null;
  readonly settlementCurrency: string | null;
  readonly settlementAmount: string | null;
  readonly fixingDate: string | null;
  readonly instrument: string | null;
  readonly buySell: string | null;
  readonly portfolio: string | null;
  readonly programId: string | null;
  readonly preTradeReference: string | null;
  /** NEAR or FAR for a swap's legs; empty otherwise. */
  readonly leg: string | null;
  readonly custom: Readonly<Record<string, string>>;
}

const KNOWN: Record<string, keyof Omit<ExecutedRow, "rowNo" | "custom">> = {
  trade_id: "tradeId", execution_platform_id: "platform", trading_entity: "tradingEntity", counterparty: "counterparty", trade_date: "tradeDate",
  value_date: "valueDate", deal_currency: "dealCurrency", deal_amount: "dealAmount", settlement_currency: "settlementCurrency",
  settlement_amount: "settlementAmount", fixing_date: "fixingDate", instrument: "instrument", buy_sell: "buySell", portfolio: "portfolio",
  hedging_program_id: "programId", pre_trade_reference: "preTradeReference", leg: "leg",
};


/** Comma-separated text with quotes. A blank line is skipped; a comma-only record (all cells empty, width > 1) is kept. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/^﻿/, "");
  const keep = (r: string[]) => r.some((x) => x.trim() !== "") || r.length > 1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (keep(row)) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (keep(row)) rows.push(row);
  return rows;
}

/** Malformed quoting before trusting splitCsv cells. rowNo is null on the header; data rows count from 1. */
export function quotingProblem(
  text: string,
): { rowNo: number | null; columnIndex: number; header: string[] | null; message: string } | null {
  let header: string[] | null = null;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let completed = 0;
  const t = text.replace(/^﻿/, "");
  const at = (columnIndex: number, message: string) => ({
    rowNo: (header === null ? null : completed) as number | null,
    columnIndex,
    header,
    message,
  });
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else cell += c;
    } else if (c === ",") {
      row.push(cell); cell = ""; afterQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = ""; afterQuote = false;
      if (row.some((x) => x.trim() !== "")) {
        if (header === null) header = row;
        completed++;
      }
      row = [];
    } else if (c === '"') {
      if (afterQuote || cell !== "") return at(row.length, "text around quotes");
      quoted = true;
    } else if (afterQuote) {
      return at(row.length, "text after closing quote");
    } else cell += c;
  }
  row.push(cell);
  if (quoted) return at(row.length - 1, "unclosed quote");
  return null;
}

/** Header names are matched ignoring case and spaces; columns we do not know become custom fields. */
export function parseExecutedFile(text: string): ExecutedRow[] {
  const [header, ...body] = splitCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return body.map((cells, i) => {
    const known: Record<string, string | null> = {};
    const custom: Record<string, string> = {};
    names.forEach((n, j) => {
      const v = (cells[j] ?? "").trim();
      const key = KNOWN[n];
      if (key) known[key] = v === "" ? null : v;
      else if (n !== "" && v !== "") custom[n] = v;
    });
    const get = (k: keyof Omit<ExecutedRow, "rowNo" | "custom">): string | null => known[k] ?? null;
    return {
      rowNo: i + 1, tradeId: get("tradeId"), platform: get("platform"), tradingEntity: get("tradingEntity"), counterparty: get("counterparty"),
      tradeDate: get("tradeDate"), valueDate: get("valueDate"), dealCurrency: get("dealCurrency"), dealAmount: get("dealAmount"),
      settlementCurrency: get("settlementCurrency"), settlementAmount: get("settlementAmount"), fixingDate: get("fixingDate"),
      instrument: get("instrument"), buySell: get("buySell"), portfolio: get("portfolio"), programId: get("programId"),
      preTradeReference: get("preTradeReference"), leg: get("leg")?.toUpperCase() ?? null, custom,
    };
  });
}

const cell = (v: string | null): string => (v === null ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export interface OutRow {
  readonly reference: string;
  readonly programId: string;
  readonly tradingEntity: string;
  readonly instrument: Instrument;
  readonly leg: string;
  readonly buySell: string;
  readonly dealCurrency: string;
  readonly dealAmount: string;
  readonly settlementCurrency: string;
  readonly settlementAmount: string | null;
  readonly valueDate: string;
  readonly fixingDate: string | null;
}

export const OUT_HEADER = ["pre_trade_reference", "hedging_program_id", "trading_entity", "instrument", "leg", "buy_sell", "deal_currency", "deal_amount", "settlement_currency", "settlement_amount", "value_date", "fixing_date"];

/** The file sent out for execution, one row per leg. */
export function toPreTradeFile(rows: readonly OutRow[]): string {
  const lines = rows.map((r) => [r.reference, r.programId, r.tradingEntity, r.instrument, r.leg === "SINGLE" ? "" : r.leg, r.buySell, r.dealCurrency, r.dealAmount, r.settlementCurrency, r.settlementAmount, r.valueDate, r.fixingDate].map((v) => cell(v === undefined ? null : v)).join(","));
  return [OUT_HEADER.join(","), ...lines].join("\n") + "\n";
}
