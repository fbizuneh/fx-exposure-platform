// Structural contract check: every service has the same shape, a README that states what it owns,
// answers, announces and consumes, and a contract/ entry point. AGENTS.md stays within its limit.
import fs from "node:fs";
import path from "node:path";
import { lineCount, listServices, read, schemaOf } from "./lib.mjs";

const SECTIONS = ["Owns", "Answers", "Announces", "Consumes", "Schema"];
const TIERS = ["core", "supporting", "generic"];
export const README_LIMIT = 60;
export const AGENTS_LIMIT = 60;

export function check(root) {
  const v = [];

  const agents = path.join(root, "AGENTS.md");
  if (!fs.existsSync(agents)) v.push("AGENTS.md: missing");
  else if (lineCount(read(agents)) > AGENTS_LIMIT) v.push(`AGENTS.md: more than ${AGENTS_LIMIT} lines`);

  for (const s of listServices(root)) {
    const base = `services/${s}`;
    for (const d of ["contract", "src", "migrations"]) {
      if (!fs.existsSync(path.join(root, base, d))) v.push(`${base}/${d}/: missing`);
    }
    if (!fs.existsSync(path.join(root, base, "contract", "index.ts"))) v.push(`${base}/contract/index.ts: missing`);

    const readme = path.join(root, base, "README.md");
    if (!fs.existsSync(readme)) {
      v.push(`${base}/README.md: missing`);
      continue;
    }
    const text = read(readme);
    if (lineCount(text) > README_LIMIT) v.push(`${base}/README.md: more than ${README_LIMIT} lines (one page)`);
    if (!/^# \S/m.test(text)) v.push(`${base}/README.md: needs a "# Service name" title`);
    const tier = /^Tier:\s*(\w+)/m.exec(text)?.[1];
    if (!tier || !TIERS.includes(tier)) v.push(`${base}/README.md: needs a "Tier:" line (core, supporting or generic)`);
    for (const sec of SECTIONS) {
      if (!new RegExp(`^## ${sec}\\s*$`, "m").test(text)) v.push(`${base}/README.md: missing "## ${sec}"`);
    }
    if (!text.includes("`" + schemaOf(s) + "`")) v.push(`${base}/README.md: Schema section must name \`${schemaOf(s)}\``);
  }
  return v;
}
