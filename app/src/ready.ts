// Is the database reachable, and has every migration file been applied? Used by /readyz.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The migration files each service has, keyed by schema name (the service folder with dashes made underscores). */
export function expectedMigrations(root = ROOT): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const service of fs.readdirSync(path.join(root, "services"))) {
    const dir = path.join(root, "services", service, "migrations");
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    if (files.length > 0) out[service.replace(/-/g, "_")] = files;
  }
  return out;
}

export type Readiness = { ready: true } | { ready: false; reason: string };

export async function checkReady(pool: pg.Pool, root = ROOT): Promise<Readiness> {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    return { ready: false, reason: `database not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    for (const [schema, files] of Object.entries(expectedMigrations(root))) {
      const done = new Set((await pool.query(`SELECT filename FROM ${schema}.schema_migrations`)).rows.map((r) => r.filename as string));
      const missing = files.filter((f) => !done.has(f));
      if (missing.length > 0) return { ready: false, reason: `${schema} has ${missing.length} migration(s) not applied, the first is ${missing[0]}` };
    }
  } catch (err) {
    return { ready: false, reason: `migrations could not be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ready: true };
}
