// Applies each service's migrations (services/<name>/migrations/*.sql, in file-name order) to its own schema.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listServices, schemaOf } from "./checks/lib.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_KEY = 727274;

/** Returns the list of "service/file" names applied by this run. */
export async function migrate(connectionString, root = DEFAULT_ROOT) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    for (const service of listServices(root)) {
      const dir = path.join(root, "services", service, "migrations");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
      if (files.length === 0) continue;
      const schema = schemaOf(service);
      if (!/^[a-z_]+$/.test(schema)) throw new Error(`unsafe schema name from folder "${service}"`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const done = new Set((await client.query(`SELECT filename FROM ${schema}.schema_migrations`)).rows.map((r) => r.filename));
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = fs.readFileSync(path.join(dir, file), "utf8");
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(`INSERT INTO ${schema}.schema_migrations (filename) VALUES ($1)`, [file]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`${service}/${file}: ${err.message}`);
        }
        applied.push(`${service}/${file}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }
  const applied = await migrate(url);
  console.log(applied.length ? `applied:\n  ${applied.join("\n  ")}` : "nothing to apply");
}
