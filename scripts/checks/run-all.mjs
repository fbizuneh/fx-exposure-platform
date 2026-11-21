// Usage: node scripts/checks/run-all.mjs [--root <dir>] [check-name]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check as importBoundary } from "./import-boundary.mjs";
import { check as schemaAccess } from "./schema-access.mjs";
import { check as contract } from "./contract.mjs";
import { check as replay } from "./replay.mjs";
import { check as tenantProgram } from "./tenant-program.mjs";
import { check as csvCopies } from "./csv-copies.mjs";

export const CHECKS = {
  "import-boundary": importBoundary,
  "schema-access": schemaAccess,
  contract,
  replay,
  "tenant-program": tenantProgram,
  "csv-copies": csvCopies,
};

export function runAll(root, only) {
  let failed = 0;
  for (const [name, fn] of Object.entries(CHECKS)) {
    if (only && only !== name) continue;
    const violations = fn(root);
    if (violations.length) {
      failed++;
      console.error(`FAIL ${name}: ${violations.length} violation(s)`);
      for (const x of violations) console.error(`  - ${x}`);
    } else {
      console.log(`ok   ${name}`);
    }
  }
  return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const root = i >= 0 ? path.resolve(args.splice(i, 2)[1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const only = args[0];
  if (only && !CHECKS[only]) {
    console.error(`unknown check "${only}"; choose from ${Object.keys(CHECKS).join(", ")}`);
    process.exit(2);
  }
  process.exit(runAll(root, only) ? 1 : 0);
}
