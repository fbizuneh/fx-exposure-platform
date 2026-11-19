// The questions Master Data answers. Each reads the version valid on the date asked about.
import { accountId, entityId, type AsOfDate, type EntityId, type TenantId } from "@shared/kernel";
import type { Account, Entity, EntityType, MasterDataQuestions, NormalBalance, StatementType } from "../contract/index.ts";
import { q, type Db } from "./db.ts";
import { ancestors, descendants } from "./tree.ts";

type EntityRowDb = Awaited<ReturnType<typeof openEntities>>[number];

function openEntities(db: Db, tenant: TenantId, asOf: AsOfDate) {
  return q(db)
    .selectFrom("entities")
    .selectAll()
    .where("tenant_id", "=", tenant)
    .where("valid_from", "<=", asOf)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
    .execute();
}

const toEntity = (r: EntityRowDb): Entity => ({
  entityId: entityId(r.entity_id),
  code: r.code,
  name: r.name,
  type: r.entity_type as EntityType,
  parentEntityId: r.parent_entity_id === null ? null : entityId(r.parent_entity_id),
  countryCode: r.country_code,
  functionalCurrency: r.functional_currency,
  isLegalEntity: r.is_legal_entity,
  isTreasuryEntity: r.is_treasury_entity,
  isHedgeExecutionEntity: r.is_hedge_execution_entity,
});

async function charts(db: Db, tenant: TenantId) {
  const rows = await q(db).selectFrom("charts_of_accounts").select(["chart_id", "code"]).where("tenant_id", "=", tenant).execute();
  return { byCode: new Map(rows.map((r) => [r.code, r.chart_id])), codeById: new Map(rows.map((r) => [r.chart_id, r.code])) };
}

function openNodes(db: Db, tenant: TenantId, asOf: AsOfDate) {
  return q(db)
    .selectFrom("gl_hierarchy_nodes")
    .selectAll()
    .where("tenant_id", "=", tenant)
    .where("valid_from", "<=", asOf)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
    .execute();
}

async function accountsOn(db: Db, tenant: TenantId, asOf: AsOfDate, where: { chartId?: string; accountNumber?: string; accountNumbers?: string[]; nodeIds?: string[] }): Promise<Account[]> {
  if ((where.nodeIds && where.nodeIds.length === 0) || (where.accountNumbers && where.accountNumbers.length === 0)) return [];
  let query = q(db)
    .selectFrom("accounts")
    .selectAll()
    .where("tenant_id", "=", tenant)
    .where("valid_from", "<=", asOf)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]));
  if (where.chartId) query = query.where("chart_id", "=", where.chartId);
  if (where.accountNumber) query = query.where("account_number", "=", where.accountNumber);
  if (where.accountNumbers) query = query.where("account_number", "in", where.accountNumbers);
  if (where.nodeIds) query = query.where("hierarchy_node_id", "in", where.nodeIds);
  const rows = await query.orderBy("account_number").execute();
  if (rows.length === 0) return [];
  const c = await charts(db, tenant);
  const nodeCode = new Map((await openNodes(db, tenant, asOf)).map((n) => [n.node_id, n.code]));
  return rows.map((r) => ({
    accountId: accountId(r.account_id),
    chartCode: c.codeById.get(r.chart_id)!,
    accountNumber: r.account_number,
    name: r.name,
    statementType: r.statement_type as StatementType,
    normalBalance: r.normal_balance as NormalBalance,
    monetaryFlag: r.monetary_flag,
    fxRelevantFlag: r.fx_relevant_flag,
    hierarchyNodeCode: r.hierarchy_node_id === null ? null : (nodeCode.get(r.hierarchy_node_id) ?? null),
  }));
}

export function masterDataQuestions(db: Db): MasterDataQuestions {
  return {
    async getEntity(tenant, code, asOf) {
      const rows = await openEntities(db, tenant, asOf);
      const r = rows.find((x) => x.code === code);
      return r ? toEntity(r) : null;
    },

    async getEntities(tenant, codes, asOf) {
      if (codes.length === 0) return [];
      const wanted = new Set(codes);
      return (await openEntities(db, tenant, asOf)).filter((r) => wanted.has(r.code)).map(toEntity);
    },

    async getAccounts(tenant, keys, asOf) {
      const byChart = new Map<string, string[]>();
      for (const k of keys) byChart.set(k.chartCode, [...(byChart.get(k.chartCode) ?? []), k.accountNumber]);
      const c = await charts(db, tenant);
      const out: Account[] = [];
      for (const [chartCode, numbers] of byChart) {
        const chartId = c.byCode.get(chartCode);
        if (chartId) out.push(...(await accountsOn(db, tenant, asOf, { chartId, accountNumbers: [...new Set(numbers)] })));
      }
      return out;
    },

    async getCurrencies(tenant, asOf) {
      const rows = await q(db).selectFrom("currencies").select(["code", "is_ndf"]).where("tenant_id", "=", tenant).where("valid_from", "<=", asOf)
        .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)])).orderBy("code").execute();
      return rows.map((r) => ({ code: r.code, isNdf: r.is_ndf }));
    },

    async hierarchyPaths(tenant, chartCode, nodeCodes, asOf) {
      const chartId = (await charts(db, tenant)).byCode.get(chartCode);
      if (!chartId || nodeCodes.length === 0) return [];
      const nodes = (await openNodes(db, tenant, asOf)).filter((n) => n.chart_id === chartId);
      const byId = new Map(nodes.map((n) => [n.node_id, n]));
      const byCode = new Map(nodes.map((n) => [n.code, n]));
      const out: { nodeCode: string; path: string[] }[] = [];
      for (const code of new Set(nodeCodes)) {
        let cur = byCode.get(code);
        if (!cur) continue;
        const path: string[] = [];
        while (cur) {
          path.push(cur.code);
          cur = cur.parent_node_id ? byId.get(cur.parent_node_id) : undefined;
        }
        out.push({ nodeCode: code, path });
      }
      return out;
    },

    async getAccount(tenant, chartCode, accountNumber, asOf) {
      const chartId = (await charts(db, tenant)).byCode.get(chartCode);
      if (!chartId) return null;
      return (await accountsOn(db, tenant, asOf, { chartId, accountNumber }))[0] ?? null;
    },

    async entityWalk(tenant, id, direction, asOf) {
      const rows = await openEntities(db, tenant, asOf);
      const idOf = (r: EntityRowDb) => r.entity_id;
      const parentOf = (r: EntityRowDb) => r.parent_entity_id;
      const walk = direction === "descendants" ? descendants(rows, idOf, parentOf, id) : ancestors(rows, idOf, parentOf, id);
      return walk.map(toEntity);
    },

    async accountsUnderNode(tenant, chartCode, nodeCode, asOf) {
      const chartId = (await charts(db, tenant)).byCode.get(chartCode);
      if (!chartId) return [];
      const nodes = (await openNodes(db, tenant, asOf)).filter((n) => n.chart_id === chartId);
      const root = nodes.find((n) => n.code === nodeCode);
      if (!root) return [];
      const below = descendants(nodes, (n) => n.node_id, (n) => n.parent_node_id, root.node_id);
      return accountsOn(db, tenant, asOf, { chartId, nodeIds: [root.node_id, ...below.map((n) => n.node_id)] });
    },

    async functionalCurrencies(tenant, ids, asOf) {
      if (ids.length === 0) return [];
      const wanted = new Set<string>(ids);
      return (await openEntities(db, tenant, asOf))
        .filter((r) => wanted.has(r.entity_id))
        .map((r) => ({ entityId: entityId(r.entity_id), currency: r.functional_currency }));
    },
  };
}
