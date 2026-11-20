// Rule 6: every row carries the tenant ID; program-scoped rows also carry the program ID.
// Each CREATE TABLE must have a tenant_id column, or the line(s) just above it must say
//   -- tenant-exempt: <reason>
// A table marked "-- program-scoped" must also have a program_id column.
// A foreign key between two tables that both have a program_id must include program_id (decision 0018), so a child row can never belong to another
// program than its parent's. Foreign keys that a later migration drops are not counted.
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

const FK_INLINE_RE = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w."]+)/gi;
const FK_ALTER_RE = /ALTER\s+TABLE\s+([\w."]+)\s+ADD\s+(?:CONSTRAINT\s+([\w"]+)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w."]+)/gi;
const DROP_RE = /ALTER\s+TABLE\s+([\w."]+)\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([\w"]+)/gi;
const ADD_COLUMN_RE = /ALTER\s+TABLE\s+([\w."]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?program_id\b/gi;
const clean = (s) => s.replace(/"/g, "").toLowerCase();
const columns = (s) => s.split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
/** Postgres names an unnamed foreign key <table>_<columns>_fkey, without the schema. */
const autoName = (table, cols) => `${clean(table).split(".").pop()}_${cols.join("_")}_fkey`;

/** Foreign keys between program-scoped tables of one service that leave out program_id. Statements are read in order, so a key dropped and added again counts as added. */
function programKeyGaps(root, service, files) {
  const hasProgram = new Set();
  let fks = []; // { table, cols, parent, name, where }
  for (const f of files) {
    const text = read(f).replace(/--.*$/gm, "");
    const where = rel(root, f);
    const events = [];
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)\s*\(/gi)) {
      const table = clean(m[1]);
      const b = body(text, m.index + m[0].length);
      events.push({ at: m.index, run: () => {
        if (/\bprogram_id\b/.test(b)) hasProgram.add(table);
        for (const k of b.matchAll(FK_INLINE_RE)) { const cols = columns(k[1]); fks.push({ table, cols, parent: clean(k[2]), name: autoName(table, cols), where }); }
      } });
    }
    for (const m of text.matchAll(ADD_COLUMN_RE)) events.push({ at: m.index, run: () => hasProgram.add(clean(m[1])) });
    for (const m of text.matchAll(FK_ALTER_RE)) events.push({ at: m.index, run: () => { const table = clean(m[1]); const cols = columns(m[3]); fks.push({ table, cols, parent: clean(m[4]), name: m[2] ? clean(m[2]) : autoName(table, cols), where }); } });
    for (const m of text.matchAll(DROP_RE)) events.push({ at: m.index, run: () => { const table = clean(m[1]).split(".").pop(); const name = clean(m[2]); fks = fks.filter((k) => !(k.table.split(".").pop() === table && k.name === name)); } });
    for (const e of events.sort((x, y) => x.at - y.at)) e.run();
  }
  const v = [];
  for (const k of fks) {
    if (hasProgram.has(k.table) && hasProgram.has(k.parent) && !k.cols.includes("program_id")) {
      v.push(`${k.where}: ${service}: foreign key (${k.cols.join(", ")}) from ${k.table} to ${k.parent} leaves out program_id, so a row could belong to another program than its parent's`);
    }
  }
  return v;
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
  for (const s of listServices(root)) v.push(...programKeyGaps(root, s, walk(path.join(root, "services", s, "migrations"), (f) => f.endsWith(".sql"))));
  return v;
}
