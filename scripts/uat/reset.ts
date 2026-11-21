import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMAS = ["audit", "identity", "master_data", "fx_rate", "data_source", "exposure_management", "exposure_analysis", "fx_trade", "hedge_recommendation"] as const;

export function uatDatabaseName(connectionString: string): string {
  let name: string;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("wrong protocol");
    name = decodeURIComponent(url.pathname.slice(1));
  }
  catch { throw new Error("DATABASE_URL is not a valid PostgreSQL URL"); }
  if (!/^[A-Za-z0-9_]+_(?:uat|test)$/.test(name)) throw new Error("uat:reset requires a database name ending in _uat or _test");
  return name;
}

export async function reset(connectionString: string): Promise<void> {
  uatDatabaseName(connectionString);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const schema of SCHEMAS) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exitCode = 1; }
  else reset(url).then(() => console.log("UAT service schemas dropped")).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
