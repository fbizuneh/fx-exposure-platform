import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS } from "../run-all.mjs";

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const readme = (title, schema, tier = "core") =>
  `# ${title}\n\nTier: ${tier}.\n\n## Owns\nx\n\n## Answers\nx\n\n## Announces\nx\n\n## Consumes\nx\n\n## Schema\n\`${schema}\`\n`;

/** Build a throwaway repo with two valid services, then apply overrides (null deletes a file). */
function repo(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
  const files = {
    "AGENTS.md": "# Agents\n",
    "services/alpha/README.md": readme("Alpha", "alpha"),
    "services/alpha/contract/index.ts": "export const alpha = 1;\n",
    "services/alpha/src/.gitkeep": "",
    "services/alpha/migrations/.gitkeep": "",
    "services/beta-two/README.md": readme("Beta Two", "beta_two", "supporting"),
    "services/beta-two/contract/index.ts": "export const beta = 1;\n",
    "services/beta-two/src/.gitkeep": "",
    "services/beta-two/migrations/.gitkeep": "",
    "shared/kernel/src/index.ts": "export const k = 1;\n",
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const run = (name, root) => CHECKS[name](root);

test("the real repository passes every check", () => {
  for (const name of Object.keys(CHECKS)) assert.deepEqual(run(name, REAL_ROOT), [], name);
});

test("a clean fixture passes every check", () => {
  const root = repo();
  for (const name of Object.keys(CHECKS)) assert.deepEqual(run(name, root), [], name);
});

test("import-boundary: another service's internals fail, its contract passes", () => {
  const bad = repo({ "services/alpha/src/a.ts": `import { x } from "@services/beta-two/src/internal";\n` });
  assert.match(run("import-boundary", bad)[0], /internals of beta-two/);
  const rel = repo({ "services/alpha/src/a.ts": `import { x } from "../../beta-two/src/x";\n` });
  assert.match(run("import-boundary", rel)[0], /reaches into beta-two/);
  const ok = repo({ "services/alpha/src/a.ts": `import { beta } from "@services/beta-two/contract";\nimport { k } from "@shared/kernel";\n` });
  assert.deepEqual(run("import-boundary", ok), []);
});

test("import-boundary: multi-line imports, app imports, other shared folders, contract importing src", () => {
  const multi = repo({ "services/alpha/src/a.ts": `import {\n  a,\n  b,\n} from "@services/beta-two/src/x";\n` });
  assert.equal(run("import-boundary", multi).length, 1);
  assert.equal(run("import-boundary", repo({ "services/alpha/src/a.ts": `import x from "../../../app/main";\n` })).length, 1);
  assert.equal(run("import-boundary", repo({ "shared/other/x.ts": "export {};\n" })).length, 1);
  assert.equal(run("import-boundary", repo({ "services/alpha/contract/c.ts": `export * from "../src/x";\n` })).length, 1);
  assert.equal(run("import-boundary", repo({ "shared/kernel/src/k.ts": `import "@services/alpha/contract";\n` })).length, 1);
});

test("schema-access: another service's schema, foreign keys, unqualified tables, stray migrations", () => {
  const sql = repo({ "services/alpha/migrations/001.sql": `CREATE TABLE alpha.t (tenant_id uuid, b uuid REFERENCES beta_two.u(id));\n` });
  assert.match(run("schema-access", sql)[0], /beta_two/);
  const unq = repo({ "services/alpha/migrations/001.sql": `CREATE TABLE t (tenant_id uuid);\n` });
  assert.match(run("schema-access", unq)[0], /must be created as alpha\.t/);
  const wrong = repo({ "services/alpha/migrations/001.sql": `CREATE TABLE beta_two.t (tenant_id uuid);\n` });
  assert.ok(run("schema-access", wrong).length >= 1);
  const ts = repo({ "services/alpha/src/r.ts": `db.withSchema("beta_two").selectFrom("t");\n` });
  assert.ok(run("schema-access", ts).length >= 1);
  const stray = repo({ "app/migrations/x.sql": "SELECT 1;\n" });
  assert.ok(run("schema-access", stray).length >= 1);
  const ok = repo({
    "services/alpha/migrations/001.sql": `-- mentions beta_two.t only in a comment\nCREATE TABLE alpha.t (tenant_id uuid);\n`,
    "services/alpha/src/r.ts": `// beta_two.u is not touched\ndb.withSchema("alpha").selectFrom("t");\n`,
  });
  assert.deepEqual(run("schema-access", ok), []);
});

test("contract: missing sections, tier, schema name, contract entry and over-long files fail", () => {
  assert.match(run("contract", repo({ "services/alpha/README.md": "# Alpha\n" })).join("\n"), /missing "## Owns"/);
  assert.match(run("contract", repo({ "services/alpha/contract/index.ts": null })).join("\n"), /contract\/index\.ts: missing/);
  assert.match(run("contract", repo({ "services/alpha/README.md": readme("Alpha", "other").replace("Tier: core.", "") })).join("\n"), /Tier/);
  assert.match(run("contract", repo({ "AGENTS.md": "x\n".repeat(61) })).join("\n"), /AGENTS\.md: more than 60/);
  assert.match(run("contract", repo({ "services/alpha/README.md": readme("Alpha", "alpha") + "x\n".repeat(60) })).join("\n"), /one page/);
});

test("replay: a handler needs an event key and a replay test", () => {
  const none = repo({ "services/alpha/src/handlers/on-thing.ts": "export const h = (eventId: string) => eventId;\n" });
  assert.match(run("replay", none)[0], /no replay test/);
  const nokey = repo({
    "services/alpha/src/handlers/on-thing.ts": "export const h = () => 1;\n",
    "services/alpha/src/handlers/on-thing.replay.test.ts": "",
  });
  assert.match(run("replay", nokey)[0], /eventId or idempotencyKey/);
  const ok = repo({
    "services/alpha/src/handlers/on-thing.ts": "export const h = (eventId: string) => eventId;\n",
    "services/alpha/src/handlers/on-thing.replay.test.ts": "",
  });
  assert.deepEqual(run("replay", ok), []);
});

test("tenant-program: tables need tenant_id unless exempt; program-scoped tables need program_id", () => {
  const mig = (sql) => repo({ "services/alpha/migrations/001.sql": sql });
  assert.match(run("tenant-program", mig(`CREATE TABLE alpha.t (id uuid);\n`))[0], /no tenant_id/);
  assert.deepEqual(run("tenant-program", mig(`-- tenant-exempt: the tenant list itself\nCREATE TABLE alpha.t (id uuid);\n`)), []);
  assert.match(run("tenant-program", mig(`CREATE TABLE alpha.t (id uuid, tenant_id uuid);\n-- program-scoped\nCREATE TABLE alpha.p (tenant_id uuid, n numeric(10, 2));\n`))[0], /program_id/);
  assert.deepEqual(run("tenant-program", mig(`-- program-scoped\nCREATE TABLE IF NOT EXISTS alpha.p (\n  tenant_id uuid NOT NULL,\n  program_id text NOT NULL,\n  amt numeric(18, 4)\n);\n`)), []);
  assert.match(run("tenant-program", mig(`-- tenant-exempt:\nCREATE TABLE alpha.t (id uuid);\n`))[0], /no tenant_id/);
});

test("tenant-program: a foreign key between two program-scoped tables must include program_id (decision 0018)", () => {
  const parent = `-- program-scoped\nCREATE TABLE alpha.runs (\n  tenant_id uuid NOT NULL,\n  run_id uuid NOT NULL,\n  program_id text NOT NULL,\n  PRIMARY KEY (tenant_id, run_id),\n  UNIQUE (tenant_id, run_id, program_id)\n);\n`;
  const child = (fk) => `-- program-scoped\nCREATE TABLE alpha.rows (\n  tenant_id uuid NOT NULL,\n  run_id uuid NOT NULL,\n  program_id text NOT NULL,\n  ${fk}\n);\n`;
  const mig = (...sql) => repo(Object.fromEntries(sql.map((s, i) => [`services/alpha/migrations/00${i + 1}.sql`, s])));
  assert.match(run("tenant-program", mig(parent + child("FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id)")))[0], /leaves out program_id/);
  assert.deepEqual(run("tenant-program", mig(parent + child("FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES alpha.runs (tenant_id, run_id, program_id)"))), []);
  // A key added later is judged too; a key dropped later is not; one dropped and added again is judged as added.
  assert.match(run("tenant-program", mig(parent + child("x int"), `ALTER TABLE alpha.rows ADD FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id);\n`))[0], /leaves out program_id/);
  assert.deepEqual(run("tenant-program", mig(parent + child("FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id)"), `ALTER TABLE alpha.rows DROP CONSTRAINT rows_tenant_id_run_id_fkey;\nALTER TABLE alpha.rows ADD FOREIGN KEY (tenant_id, run_id, program_id) REFERENCES alpha.runs (tenant_id, run_id, program_id);\n`)), []);
  assert.match(run("tenant-program", mig(parent + child("FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id)"), `ALTER TABLE alpha.rows DROP CONSTRAINT rows_tenant_id_run_id_fkey;\nALTER TABLE alpha.rows ADD FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id);\n`))[0], /leaves out program_id/);
  // A child with no program_id of its own (or a parent with none) is not subject to it.
  assert.deepEqual(run("tenant-program", mig(parent + `CREATE TABLE alpha.notes (\n  tenant_id uuid NOT NULL,\n  run_id uuid NOT NULL,\n  FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id)\n);\n`)), []);
  assert.deepEqual(run("tenant-program", mig(parent + child("FOREIGN KEY (tenant_id, run_id) REFERENCES alpha.runs (tenant_id, run_id)"), `ALTER TABLE alpha.runs DROP COLUMN program_id;\n`)), []);
});
