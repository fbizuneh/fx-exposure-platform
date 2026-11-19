// Rule 6: every row carries the tenant ID; program-scoped rows also carry the program ID.
// Each CREATE TABLE must have a tenant_id column, or the line(s) just above it must say
//   -- tenant-exempt: <reason>
// A table marked "-- program-scoped" must also have a program_id column.
import path from "node:path";
import { listServices, read, rel, walk } from "./lib.mjs";

const TABLE_RE = /((?:[ \t]*--[^\n]*\n)*)[ \t]*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s*\(/gi;

function body(text, open) {
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

export function check(root) {
  const v = [];
  for (const s of listServices(root)) {
    const files = walk(path.join(root, "services", s, "migrations"), (f) => f.endsWith(".sql"));
    for (const f of files) {
      const text = read(f);
      for (const m of text.matchAll(TABLE_RE)) {
        const [whole, comments, name] = m;
        const cols = body(text, m.index + whole.length).replace(/--.*$/gm, "");
        const where = `${rel(root, f)}: table ${name.replace(/"/g, "")}`;
        const exempt = /tenant-exempt:\s*\S/.test(comments);
        if (!exempt && !/\btenant_id\b/.test(cols)) v.push(`${where} has no tenant_id (or add "-- tenant-exempt: <reason>")`);
        if (/program-scoped/.test(comments) && !/\bprogram_id\b/.test(cols)) v.push(`${where} is program-scoped but has no program_id`);
      }
    }
  }
  return v;
}
