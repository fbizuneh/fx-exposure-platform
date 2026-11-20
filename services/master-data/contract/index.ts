// Published questions and events of Master Data. Other services import this file, never src/.
import type { ChangeRecordFields } from "@services/audit/contract";
import type { AccountId, AsOfDate, EntityId, TenantId } from "@shared/kernel";

export const ENTITY_TYPES = [
  "GROUP",
  "REGION",
  "LEGAL_ENTITY",
  "BUSINESS_UNIT",
  "DIVISION",
  "PROFIT_CENTER",
  "COST_CENTER",
  "PROJECT",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const STATEMENT_TYPES = ["BALANCE_SHEET", "INCOME_STATEMENT", "CASH_FLOW"] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const NORMAL_BALANCES = ["DEBIT", "CREDIT"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

export const HIERARCHY_CLASSIFICATIONS = [
  "BALANCE_SHEET",
  "ASSETS",
  "LIABILITIES",
  "EQUITY",
  "INCOME_STATEMENT",
  "REVENUE",
  "COGS",
  "OPERATING_EXPENSES",
  "OTHER_INCOME_EXPENSE",
] as const;
export type HierarchyClassification = (typeof HIERARCHY_CLASSIFICATIONS)[number];

/** An entity as it stood on the date asked about. */
export interface Entity {
  readonly entityId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly type: EntityType;
  readonly parentEntityId: EntityId | null;
  readonly countryCode: string | null;
  readonly functionalCurrency: string | null;
  readonly isLegalEntity: boolean;
  readonly isTreasuryEntity: boolean;
  readonly isHedgeExecutionEntity: boolean;
}

/** An account as it stood on the date asked about. The account number is the code as received. */
export interface Account {
  readonly accountId: AccountId;
  readonly chartCode: string;
  readonly accountNumber: string;
  readonly name: string;
  readonly statementType: StatementType;
  readonly normalBalance: NormalBalance;
  readonly monetaryFlag: boolean;
  readonly fxRelevantFlag: boolean;
  readonly hierarchyNodeCode: string | null;
}

/** A currency as it stood on the date asked about. */
export interface Currency {
  readonly code: string;
  readonly isNdf: boolean;
}

/** Every question reads the version valid on `asOf`, so history does not change when master data does. */
export interface MasterDataQuestions {
  getEntity(tenantId: TenantId, code: string, asOf: AsOfDate): Promise<Entity | null>;
  getAccount(tenantId: TenantId, chartCode: string, accountNumber: string, asOf: AsOfDate): Promise<Account | null>;
  /** Several entities by code in one call. Unknown codes are left out. */
  getEntities(tenantId: TenantId, codes: readonly string[], asOf: AsOfDate): Promise<readonly Entity[]>;
  /** Several accounts in one call. Unknown accounts are left out. */
  getAccounts(
    tenantId: TenantId,
    keys: readonly { readonly chartCode: string; readonly accountNumber: string }[],
    asOf: AsOfDate,
  ): Promise<readonly Account[]>;
  /** The currencies on record on the date, with whether each trades as an NDF. A currency not on record is not an NDF. */
  getCurrencies(tenantId: TenantId, asOf: AsOfDate): Promise<readonly Currency[]>;
  /** For each hierarchy node: its own code, then its ancestors nearest first. Unknown nodes are left out. */
  hierarchyPaths(
    tenantId: TenantId,
    chartCode: string,
    nodeCodes: readonly string[],
    asOf: AsOfDate,
  ): Promise<readonly { readonly nodeCode: string; readonly path: readonly string[] }[]>;
  /** Everything under an entity (descendants) or above it (ancestors, nearest first). The entity itself is not included. */
  entityWalk(tenantId: TenantId, entityId: EntityId, direction: "descendants" | "ancestors", asOf: AsOfDate): Promise<readonly Entity[]>;
  /** The accounts on a hierarchy node and on every node beneath it. */
  accountsUnderNode(tenantId: TenantId, chartCode: string, nodeCode: string, asOf: AsOfDate): Promise<readonly Account[]>;
  /** Null for an entity that has none (only legal entities must have one). Unknown entities are left out. */
  functionalCurrencies(
    tenantId: TenantId,
    entityIds: readonly EntityId[],
    asOf: AsOfDate,
  ): Promise<readonly { readonly entityId: EntityId; readonly currency: string | null }[]>;
}

/** One event per applied change set. It carries identifiers only; receivers ask Master Data for detail. */
export interface MasterDataChanged {
  readonly type: "master-data.changed";
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly batchId: string;
  readonly kind: "ENTITY" | "HIERARCHY" | "ACCOUNT" | "CURRENCY";
  readonly asOf: AsOfDate;
}

/** A change record for Audit (decision 0012): who did what to which record. Identifiers and field names only. */
export interface MasterDataChangeRecorded extends ChangeRecordFields {
  readonly type: "master-data.change-recorded";
  readonly eventId: string;
  readonly occurredAt: string;
}
export type MasterDataEvents = MasterDataChanged | MasterDataChangeRecorded;
