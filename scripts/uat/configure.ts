import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { programId, type TenantId } from "@shared/kernel";
import { TENANT_ROLES, type Actor, type TenantRole } from "../../services/identity/contract/index.ts";
import type { ProgramType } from "@services/exposure-management/contract";
import { composeApp, type App } from "../../app/src/compose.ts";
import { drain } from "../../app/src/dispatch.ts";

type PolicyInput = Parameters<App["hedgeRecommendation"]["commands"]["setPolicy"]>[0]["policy"];
type SettingsInput = Parameters<App["exposureManagement"]["commands"]["defineProgram"]>[0]["settings"];
type NewRule = Parameters<App["dataSource"]["commands"]["addMappingRule"]>[0];

interface UserConfig { readonly name: string; readonly externalSubject: string; readonly roles: readonly TenantRole[] }
interface ProgramConfig {
  readonly id: string;
  readonly name: string;
  readonly type: ProgramType;
  readonly effectiveFrom: string;
  readonly settings: SettingsInput;
  readonly mappingRules: readonly Omit<NewRule, "tenantId" | "programId" | "by">[];
  readonly policy: PolicyInput;
}
export interface UatConfig {
  readonly tenantName: string;
  readonly OIDC_ISSUER: string;
  readonly platformUser: { readonly issuer: string; readonly externalSubject: string; readonly displayName: string };
  readonly users: readonly UserConfig[];
  readonly adminUser: string;
  readonly programs: readonly ProgramConfig[];
  readonly rateSettings: { readonly preferredSource: string; readonly staleAfterMinutes: number; readonly pivotCurrency: string; readonly outlierShare: number };
  readonly simulator: { readonly portfolioByProgram: Readonly<Record<string, string>> };
}

/** Configures an empty UAT tenant through the same commands used by the app. */
export async function configure(app: App, config: UatConfig): Promise<TenantId> {
  if (!config.tenantName?.trim() || config.tenantName !== config.tenantName.trim()) throw new Error("tenantName must be non-blank without surrounding spaces");
  if (await app.identity.questions.tenantByName(config.tenantName)) throw new Error(`tenant ${config.tenantName} already exists`);
  if (config.programs.length !== 2 || new Set(config.programs.map((p) => p.id)).size !== 2) throw new Error("UAT config needs two distinct programs");
  const admin = config.users.find((u) => u.name === config.adminUser);
  if (!admin || !admin.roles.includes("TREASURY_ADMIN")) throw new Error("adminUser must name a TREASURY_ADMIN in users");
  if (new Set(config.users.map((u) => u.name)).size !== config.users.length) throw new Error("user names must be distinct");
  for (const user of config.users) {
    if (!user.externalSubject || !user.roles.every((r) => (TENANT_ROLES as readonly string[]).includes(r))) throw new Error(`invalid user ${user.name}`);
  }

  const tenantId = await app.identity.commands.createTenant(config.tenantName);
  const platformId = await app.identity.commands.ensurePlatformUser(config.platformUser);
  for (const p of config.programs) await app.identity.commands.enableProgram(tenantId, programId(p.id), platformId);
  const actors = new Map<string, Actor>();
  for (const user of config.users) {
    const userId = await app.identity.commands.addUser(tenantId, { issuer: config.OIDC_ISSUER, externalSubject: user.externalSubject, displayName: user.name, roles: user.roles }, platformId);
    actors.set(user.name, { kind: "user", userId });
  }
  const adminActor = actors.get(config.adminUser)!;
  for (const p of config.programs) {
    await app.exposureManagement.commands.defineProgram({ tenantId, programId: p.id, name: p.name, type: p.type, effectiveFrom: p.effectiveFrom, actor: adminActor, settings: p.settings });
  }
  // Data Source needs the enabled/defined program announcements before it accepts mapping rules.
  await drain(app);
  for (const p of config.programs) {
    for (const rule of p.mappingRules) await app.dataSource.commands.addMappingRule({ ...rule, tenantId, programId: p.id, by: `user:${adminActor.kind === "user" ? adminActor.userId : ""}` });
    await app.hedgeRecommendation.commands.setPolicy({ tenantId, programId: programId(p.id), actor: adminActor, policy: p.policy });
  }
  await app.fxRate.commands.setPreferredSource(tenantId, config.rateSettings.preferredSource);
  await app.fxRate.commands.setStaleAfter(tenantId, config.rateSettings.preferredSource, config.rateSettings.staleAfterMinutes);
  await app.fxRate.commands.setPivotCurrency(tenantId, config.rateSettings.pivotCurrency);
  await app.fxRate.commands.setOutlierShare(tenantId, config.rateSettings.outlierShare);
  await drain(app);
  return tenantId;
}

function option(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) throw new Error(`missing ${name}`);
  return args[i + 1]!;
}
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const config = JSON.parse(await readFile(option(process.argv.slice(2), "--config"), "utf8")) as UatConfig;
  const app = composeApp(connectionString);
  try { console.log(`configured tenant ${await configure(app, config)}`); }
  finally { await app.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
