// Pure CSV parsers for Master Data file kinds (docs/file-layouts.md). Shape only; no database.
import {
  ENTITY_TYPES,
  HIERARCHY_CLASSIFICATIONS,
  NORMAL_BALANCES,
  STATEMENT_TYPES,
  WEEKDAYS,
  type EntityType,
  type HierarchyClassification,
  type NormalBalance,
  type StatementType,
  type Weekday,
} from "../contract/index.ts";
import { quotingProblems, splitCsv } from "./csv.ts";
import type {
  AccountRow,
  CalendarRow,
  CurrencyRow,
  EntityRow,
  HierarchyNodeRow,
  PairExposureCurrencyRow,
} from "./rows.ts";

export interface FileProblem {
  readonly rowNo: number | null;
  readonly column: string | null;
  readonly message: string;
}

export interface ParseResult<T> {
  readonly rows: T[];
  readonly problems: FileProblem[];
}

const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const normalizeHeader = (h: string): string => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

const cell = (raw: string | undefined): string | null => {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
};

const realDate = (v: string): boolean => {
  const m = DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

const has = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

const weekendKey = (days: readonly Weekday[]): string => [...days].sort().join("|");

function openCsv(text: string): { header: string[] | undefined; body: string[][]; problems: FileProblem[] } {
  const problems: FileProblem[] = [];
  for (const bad of quotingProblems(text)) {
    const raw = bad.header?.[bad.columnIndex];
    const column = raw !== undefined && raw.trim() !== "" ? normalizeHeader(raw) : null;
    problems.push({ rowNo: bad.rowNo, column, message: bad.message });
  }
  const [header, ...body] = splitCsv(text);
  return { header, body, problems };
}

function assertWidth(problems: FileProblem[], rowNo: number, cells: string[], width: number): boolean {
  if (cells.length === width) return true;
  problems.push({
    rowNo,
    column: null,
    message: `row has ${cells.length} columns; header has ${width}`,
  });
  return false;
}

interface ColumnMap {
  readonly index: Map<string, number>;
  readonly problems: FileProblem[];
}

/** Match headers ignoring case and spaces; report missing, duplicate and unknown columns. */
function mapColumns(header: string[] | undefined, required: readonly string[], optional: readonly string[] = []): ColumnMap {
  const problems: FileProblem[] = [];
  const index = new Map<string, number>();
  if (!header) {
    for (const name of required) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
    return { index, problems };
  }
  const known = new Set([...required, ...optional]);
  const seen = new Map<string, number>();
  header.forEach((raw, i) => {
    const name = normalizeHeader(raw);
    if (name === "") {
      problems.push({ rowNo: null, column: null, message: `empty column header at position ${i + 1}` });
      return;
    }
    if (seen.has(name)) {
      problems.push({ rowNo: null, column: name, message: `duplicate column ${name}` });
      return;
    }
    seen.set(name, i);
    if (!known.has(name)) {
      problems.push({ rowNo: null, column: name, message: `unknown column ${name}` });
      return;
    }
    index.set(name, i);
  });
  for (const name of required) {
    if (!index.has(name)) problems.push({ rowNo: null, column: name, message: `missing required column ${name}` });
  }
  return { index, problems };
}

function get(cells: string[], index: Map<string, number>, name: string): string | null {
  const i = index.get(name);
  if (i === undefined) return null;
  return cell(cells[i]);
}

function requireText(problems: FileProblem[], rowNo: number, column: string, value: string | null): string | null {
  if (value === null) {
    problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  return value;
}

function parseBool(problems: FileProblem[], rowNo: number, column: string, value: string | null, required: boolean): boolean | null {
  if (value === null) {
    if (required) problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  if (value !== "true" && value !== "false") {
    problems.push({ rowNo, column, message: `${column} must be true or false` });
    return null;
  }
  return value === "true";
}

function parseCurrency(problems: FileProblem[], rowNo: number, column: string, value: string | null, required: boolean): string | null {
  if (value === null) {
    if (required) problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  if (!CURRENCY.test(value)) {
    problems.push({ rowNo, column, message: `${column} must be three upper-case letters` });
    return null;
  }
  return value;
}

function parseDate(problems: FileProblem[], rowNo: number, column: string, value: string | null, required: boolean): string | null {
  if (value === null) {
    if (required) problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  if (!realDate(value)) {
    problems.push({ rowNo, column, message: `${column} must be a real date written YYYY-MM-DD` });
    return null;
  }
  return value;
}

function parseEnum<T extends string>(
  problems: FileProblem[],
  rowNo: number,
  column: string,
  value: string | null,
  allowed: readonly T[],
): T | null {
  if (value === null) {
    problems.push({ rowNo, column, message: `${column} is required` });
    return null;
  }
  if (!has(allowed, value)) {
    problems.push({ rowNo, column, message: `${column} must be one of ${allowed.join(", ")}` });
    return null;
  }
  return value;
}

const ENTITY_REQUIRED = [
  "code",
  "name",
  "type",
  "is_legal_entity",
  "is_treasury_entity",
  "is_hedge_execution_entity",
] as const;
const ENTITY_OPTIONAL = ["parent_code", "country_code", "functional_currency"] as const;

export function parseEntitiesFile(text: string): ParseResult<EntityRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, ENTITY_REQUIRED, ENTITY_OPTIONAL);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  const rows: EntityRow[] = [];
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const code = requireText(problems, rowNo, "code", get(cells, index, "code"));
    const name = requireText(problems, rowNo, "name", get(cells, index, "name"));
    const type = parseEnum(problems, rowNo, "type", get(cells, index, "type"), ENTITY_TYPES);
    const parentCode = get(cells, index, "parent_code");
    const countryRaw = get(cells, index, "country_code");
    let countryCode: string | null = null;
    if (countryRaw !== null) {
      if (!COUNTRY.test(countryRaw)) problems.push({ rowNo, column: "country_code", message: "country_code must be two upper-case letters" });
      else countryCode = countryRaw;
    }
    const functionalCurrency = parseCurrency(problems, rowNo, "functional_currency", get(cells, index, "functional_currency"), false);
    const isLegalEntity = parseBool(problems, rowNo, "is_legal_entity", get(cells, index, "is_legal_entity"), true);
    const isTreasuryEntity = parseBool(problems, rowNo, "is_treasury_entity", get(cells, index, "is_treasury_entity"), true);
    const isHedgeExecutionEntity = parseBool(problems, rowNo, "is_hedge_execution_entity", get(cells, index, "is_hedge_execution_entity"), true);
    if (
      code !== null &&
      name !== null &&
      type !== null &&
      isLegalEntity !== null &&
      isTreasuryEntity !== null &&
      isHedgeExecutionEntity !== null &&
      (countryRaw === null || countryCode !== null) &&
      (get(cells, index, "functional_currency") === null || functionalCurrency !== null)
    ) {
      rows.push({
        code,
        name,
        type: type as EntityType,
        parentCode,
        countryCode,
        functionalCurrency,
        isLegalEntity,
        isTreasuryEntity,
        isHedgeExecutionEntity,
      });
    }
  });
  return { rows: problems.length > 0 ? [] : rows, problems };
}

const HIERARCHY_REQUIRED = ["chart_code", "code", "name", "classification"] as const;
const HIERARCHY_OPTIONAL = ["parent_code"] as const;

export function parseHierarchyFile(text: string): ParseResult<HierarchyNodeRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, HIERARCHY_REQUIRED, HIERARCHY_OPTIONAL);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  const rows: HierarchyNodeRow[] = [];
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const chartCode = requireText(problems, rowNo, "chart_code", get(cells, index, "chart_code"));
    const code = requireText(problems, rowNo, "code", get(cells, index, "code"));
    const name = requireText(problems, rowNo, "name", get(cells, index, "name"));
    const classification = parseEnum(problems, rowNo, "classification", get(cells, index, "classification"), HIERARCHY_CLASSIFICATIONS);
    const parentCode = get(cells, index, "parent_code");
    if (chartCode !== null && code !== null && name !== null && classification !== null) {
      rows.push({ chartCode, code, name, classification: classification as HierarchyClassification, parentCode });
    }
  });
  return { rows: problems.length > 0 ? [] : rows, problems };
}

const ACCOUNT_REQUIRED = [
  "chart_code",
  "account_number",
  "name",
  "statement_type",
  "normal_balance",
  "monetary_flag",
  "fx_relevant_flag",
] as const;
const ACCOUNT_OPTIONAL = ["hierarchy_node_code"] as const;

export function parseAccountsFile(text: string): ParseResult<AccountRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, ACCOUNT_REQUIRED, ACCOUNT_OPTIONAL);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  const rows: AccountRow[] = [];
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const chartCode = requireText(problems, rowNo, "chart_code", get(cells, index, "chart_code"));
    const accountNumber = requireText(problems, rowNo, "account_number", get(cells, index, "account_number"));
    const name = requireText(problems, rowNo, "name", get(cells, index, "name"));
    const statementType = parseEnum(problems, rowNo, "statement_type", get(cells, index, "statement_type"), STATEMENT_TYPES);
    const normalBalance = parseEnum(problems, rowNo, "normal_balance", get(cells, index, "normal_balance"), NORMAL_BALANCES);
    const monetaryFlag = parseBool(problems, rowNo, "monetary_flag", get(cells, index, "monetary_flag"), true);
    const fxRelevantFlag = parseBool(problems, rowNo, "fx_relevant_flag", get(cells, index, "fx_relevant_flag"), true);
    const hierarchyNodeCode = get(cells, index, "hierarchy_node_code");
    if (
      chartCode !== null &&
      accountNumber !== null &&
      name !== null &&
      statementType !== null &&
      normalBalance !== null &&
      monetaryFlag !== null &&
      fxRelevantFlag !== null
    ) {
      rows.push({
        chartCode,
        accountNumber,
        name,
        statementType: statementType as StatementType,
        normalBalance: normalBalance as NormalBalance,
        monetaryFlag,
        fxRelevantFlag,
        hierarchyNodeCode,
      });
    }
  });
  return { rows: problems.length > 0 ? [] : rows, problems };
}

export function parseCurrenciesFile(text: string): ParseResult<CurrencyRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, ["code", "is_ndf"]);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  const rows: CurrencyRow[] = [];
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const code = parseCurrency(problems, rowNo, "code", get(cells, index, "code"), true);
    const isNdf = parseBool(problems, rowNo, "is_ndf", get(cells, index, "is_ndf"), true);
    if (code !== null && isNdf !== null) rows.push({ code, isNdf });
  });
  return { rows: problems.length > 0 ? [] : rows, problems };
}

const CALENDAR_REQUIRED = ["currency_code", "weekend_days", "covered_through"] as const;
const CALENDAR_OPTIONAL = ["holiday_date", "holiday_name"] as const;

export function parseCalendarsFile(text: string): ParseResult<CalendarRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, CALENDAR_REQUIRED, CALENDAR_OPTIONAL);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  type Acc = {
    weekendDays: Weekday[];
    coveredThrough: string;
    holidays: { date: string; name: string | null }[];
    weekendKey: string;
  };
  const byCurrency = new Map<string, Acc>();

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const currencyCode = parseCurrency(problems, rowNo, "currency_code", get(cells, index, "currency_code"), true);
    const weekendRaw = get(cells, index, "weekend_days");
    const coveredThrough = parseDate(problems, rowNo, "covered_through", get(cells, index, "covered_through"), true);
    const holidayDate = parseDate(problems, rowNo, "holiday_date", get(cells, index, "holiday_date"), false);
    const holidayName = get(cells, index, "holiday_name");

    // Empty cell (null after trim) means no weekend days.
    let weekendDays: Weekday[] | null = null;
    if (weekendRaw === null) {
      weekendDays = [];
    } else {
      const parts = weekendRaw.split("|");
      const parsed: Weekday[] = [];
      let ok = true;
      for (const part of parts) {
        if (!has(WEEKDAYS, part)) {
          problems.push({
            rowNo,
            column: "weekend_days",
            message: `weekend_days must be ${WEEKDAYS.join(", ")} separated by |`,
          });
          ok = false;
          break;
        }
        parsed.push(part);
      }
      if (ok) weekendDays = parsed;
    }

    if (get(cells, index, "holiday_date") === null && holidayName !== null) {
      problems.push({ rowNo, column: "holiday_name", message: "holiday_name requires holiday_date" });
    }
    if (holidayName !== null && holidayName.trim() === "") {
      problems.push({ rowNo, column: "holiday_name", message: "holiday_name must not be blank" });
    }

    if (currencyCode === null || weekendDays === null || coveredThrough === null) return;
    if (get(cells, index, "holiday_date") !== null && holidayDate === null) return;
    if (get(cells, index, "holiday_date") === null && holidayName !== null) return;

    const key = weekendKey(weekendDays);
    const existing = byCurrency.get(currencyCode);
    if (!existing) {
      byCurrency.set(currencyCode, {
        weekendDays,
        coveredThrough,
        weekendKey: key,
        holidays: holidayDate === null ? [] : [{ date: holidayDate, name: holidayName }],
      });
      return;
    }
    if (existing.weekendKey !== key) {
      problems.push({
        rowNo,
        column: "weekend_days",
        message: `weekend_days for ${currencyCode} disagrees with earlier rows`,
      });
    }
    if (existing.coveredThrough !== coveredThrough) {
      problems.push({
        rowNo,
        column: "covered_through",
        message: `covered_through for ${currencyCode} disagrees with earlier rows`,
      });
    }
    if (holidayDate !== null) existing.holidays.push({ date: holidayDate, name: holidayName });
  });

  if (problems.length > 0) return { rows: [], problems };
  const rows: CalendarRow[] = [...byCurrency.entries()].map(([currencyCode, acc]) => ({
    currencyCode,
    weekendDays: acc.weekendDays,
    coveredThrough: acc.coveredThrough,
    holidays: acc.holidays,
  }));
  return { rows, problems };
}

export function parseExposureCurrenciesFile(text: string): ParseResult<PairExposureCurrencyRow> {
  const opened = openCsv(text);
  const { header, body } = opened;
  const mapped = mapColumns(header, ["pair", "exposure_currency"]);
  const problems = [...opened.problems, ...mapped.problems];
  const { index } = mapped;
  const rows: PairExposureCurrencyRow[] = [];
  if (mapped.problems.length > 0) return { rows: [], problems };
  const width = header!.length;

  body.forEach((cells, i) => {
    const rowNo = i + 1;
    if (!assertWidth(problems, rowNo, cells, width)) return;
    const pair = requireText(problems, rowNo, "pair", get(cells, index, "pair"));
    const exposureCurrency = parseCurrency(problems, rowNo, "exposure_currency", get(cells, index, "exposure_currency"), true);
    if (pair === null || exposureCurrency === null) return;
    const parts = pair.split("-");
    if (parts.length !== 2 || !CURRENCY.test(parts[0]!) || !CURRENCY.test(parts[1]!) || parts[0] === parts[1]) {
      problems.push({ rowNo, column: "pair", message: "pair must be two different three-letter currencies joined by -" });
      return;
    }
    if (!parts.includes(exposureCurrency)) {
      problems.push({ rowNo, column: "exposure_currency", message: "exposure_currency must be one of the pair" });
      return;
    }
    rows.push({ pair, exposureCurrency });
  });
  return { rows: problems.length > 0 ? [] : rows, problems };
}
