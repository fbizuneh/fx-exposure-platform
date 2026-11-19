// Programs and their settings. A program is defined once Identity has enabled its code; settings are appended as versions.
import { sql } from "kysely";
import type { TenantId } from "@shared/kernel";
import { PROGRAM_TYPES, type ProgramType } from "../contract/index.ts";
import type { Actor, ProgramDisabled, ProgramEnabled } from "@services/identity/contract";
import { require_, who, type IdentityPort } from "./access.ts";
import { q, type Db } from "./db.ts";
import { announce } from "./outbox.ts";
import { combinationProblem, realDate, validateSettings, type SettingsInput } from "./rules.ts";
import { programId as toProgramId } from "@shared/kernel";

export class ProgramRefused extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`program refused: ${problems.slice(0, 3).join("; ")}`);
    this.problems = problems;
  }
}

export interface NewProgram {
  readonly tenantId: TenantId;
  readonly programId: string;
  readonly name: string;
  readonly type: ProgramType;
  readonly settings: SettingsInput;
  /** The first day the settings apply. */
  readonly effectiveFrom: string;
  readonly actor: Actor;
}

export interface SettingsChange {
  readonly tenantId: TenantId;
  readonly programId: string;
  readonly settings: SettingsInput;
  readonly effectiveFrom: string;
  readonly actor: Actor;
}

const filled = (v: string): boolean => typeof v === "string" && v.trim() !== "" && v === v.trim() && v.length <= 64;

export function programCommands(db: Db, access: IdentityPort) {
  const settingsRow = (tenant: TenantId, program: string, s: SettingsInput, from: string, by: string) => ({
    tenant_id: tenant, program_id: program, valid_from: from, valid_to: null,
    netting_level: s.nettingLevel as "ENTITY_PAIR" | "CORPORATE_PAIR" | "REGION_PAIR", bucket_scheme: JSON.stringify(s.bucketScheme),
    schedule: s.schedule === null ? null : JSON.stringify(s.schedule), changed_by: by,
  });

  async function setEnabled(tenant: TenantId, program: string, enabled: boolean): Promise<boolean> {
    return db.transaction().execute(async (tx) => {
      const r = await q(tx).updateTable("programs").set({ enabled, updated_at: new Date() })
        .where("tenant_id", "=", tenant).where("program_id", "=", program).where("enabled", "<>", enabled).returning("program_id").executeTakeFirst();
      if (!r) return false; // unknown program, or already in that state: repeating an event changes nothing
      await announce(tx, { type: "exposure-management.program-changed", tenantId: tenant, programId: toProgramId(program) });
      return true;
    });
  }

  return {
    async defineProgram(input: NewProgram): Promise<void> {
      const problems: string[] = [];
      if (!filled(input.programId)) problems.push("program ID is required (up to 64 characters, no surrounding spaces)");
      if (!filled(input.name)) problems.push("name is required");
      if (!(PROGRAM_TYPES as readonly string[]).includes(input.type)) problems.push(`type must be one of ${PROGRAM_TYPES.join(", ")}`);
      if (!realDate(input.effectiveFrom)) problems.push("effective date is not a date");
      problems.push(...validateSettings(input.settings));
      if (problems.length > 0) throw new ProgramRefused(problems);
      await require_(access, input.tenantId, input.actor, "program:manage");
      if (!(await access.enabledPrograms(input.tenantId)).includes(toProgramId(input.programId))) {
        throw new ProgramRefused([`program ${input.programId} is not enabled for this tenant in Identity`]);
      }
      await db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.tenantId}:programs`}))`.execute(tx);
        const have = await q(tx).selectFrom("programs").select(["program_id", "program_type"]).where("tenant_id", "=", input.tenantId).execute();
        if (have.some((p) => p.program_id === input.programId)) throw new ProgramRefused([`program ${input.programId} is already defined`]);
        const clash = combinationProblem(have.map((p) => p.program_type), input.type);
        if (clash) throw new ProgramRefused([clash]);
        await q(tx).insertInto("programs").values({
          tenant_id: input.tenantId, program_id: input.programId, name: input.name, program_type: input.type, enabled: true, created_by: who(input.actor),
        }).execute();
        await q(tx).insertInto("program_settings").values(settingsRow(input.tenantId, input.programId, input.settings, input.effectiveFrom, who(input.actor))).execute();
        await announce(tx, { type: "exposure-management.program-changed", tenantId: input.tenantId, programId: toProgramId(input.programId) });
      });
    },

    /** Adds a version of a program's settings from a later date. History is never rewritten. */
    async changeSettings(input: SettingsChange): Promise<void> {
      const problems = [...validateSettings(input.settings), ...(realDate(input.effectiveFrom) ? [] : ["effective date is not a date"])];
      if (problems.length > 0) throw new ProgramRefused(problems);
      await require_(access, input.tenantId, input.actor, "program:manage", toProgramId(input.programId));
      await db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.tenantId}:programs`}))`.execute(tx);
        const open = await q(tx).selectFrom("program_settings").select("valid_from").where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).where("valid_to", "is", null).executeTakeFirst();
        if (!open) throw new ProgramRefused([`program ${input.programId} is not defined`]);
        if (input.effectiveFrom <= open.valid_from) throw new ProgramRefused([`new settings must start after ${open.valid_from}, when the current ones start`]);
        await q(tx).updateTable("program_settings").set({ valid_to: input.effectiveFrom }).where("tenant_id", "=", input.tenantId).where("program_id", "=", input.programId).where("valid_to", "is", null).execute();
        await q(tx).insertInto("program_settings").values(settingsRow(input.tenantId, input.programId, input.settings, input.effectiveFrom, who(input.actor))).execute();
        await announce(tx, { type: "exposure-management.program-changed", tenantId: input.tenantId, programId: toProgramId(input.programId) });
      });
    },

    /** From Identity. Safe to repeat. */
    onProgramEnabled: (e: Pick<ProgramEnabled, "tenantId" | "programId">) => setEnabled(e.tenantId, e.programId, true),
    onProgramDisabled: (e: Pick<ProgramDisabled, "tenantId" | "programId">) => setEnabled(e.tenantId, e.programId, false),
  };
}
