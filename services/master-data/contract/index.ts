// Published questions and events of Master Data. Other services import this file, never src/.
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

/** Every question reads the version valid on `asOf`, so history does not change when master data does. */
export interface MasterDataQuestions {
  getEntity(tenantId: TenantId, code: string, asOf: AsOfDate): Promise<Entity | null>;
  getAccount(tenantId: TenantId, chartCode: string, accountNumber: string, asOf: AsOfDate): Promise<Account | null>;
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
  readonly kind: "ENTITY" | "HIERARCHY" | "ACCOUNT";
  readonly asOf: AsOfDate;
}
export type MasterDataEvents = MasterDataChanged;
