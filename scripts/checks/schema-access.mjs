// Rules 1 and 4: a service touches only its own schema and holds its own migrations;
// no foreign keys or references across schemas.
import fs from "node:fs";
import path from "node:path";
import { listServices, read, rel, schemaOf, walk } from "./lib.mjs";

const stripTs = (t) => t.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const stripSql = (t) => t.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

export function check(root) {
  const v = [];
  const services = listServices(root);

  for (const s of services) {
    const own = schemaOf(s);
    const others = services.filter((o) => o !== s).map(schemaOf);
    const files = walk(path.join(root, "services", s), (f) => /\.(ts|tsx|mts|cts|sql)$/.test(f) && !f.endsWith(".d.ts"));
    for (const f of files) {
      const where = rel(root, f);
      const isSql = f.endsWith(".sql");
      const text = isSql ? stripSql(read(f)) : stripTs(read(f));

      for (const o of others) {
        const qualified = new RegExp(`(?<![A-Za-z0-9_])["'\`]?${o}["'\`]?\\s*\\.\\s*["'\`]?[A-Za-z_]`);
        if (qualified.test(text)) v.push(`${where}: touches schema "${o}", which belongs to another service`);
      }
      for (const m of text.matchAll(/withSchema\(\s*['"`]([^'"`]+)['"`]/g)) {
        if (m[1] !== own) v.push(`${where}: withSchema("${m[1]}") but this service owns "${own}"`);
      }
      if (isSql) {
        for (const m of text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)) {
          const name = m[1].replace(/"/g, "");
          if (!name.includes(".")) v.push(`${where}: table "${name}" must be created as ${own}.${name}`);
          else if (name.split(".")[0] !== own) v.push(`${where}: creates ${name} outside schema "${own}"`);
        }
      }
    }
  }

  // Migrations live only inside the owning service.
  for (const top of ["app", "shared"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir, (x) => x.endsWith(".sql"))) v.push(`${rel(root, f)}: migrations belong in services/<name>/migrations`);
    const stack = [dir];
    while (stack.length) {
      for (const e of fs.readdirSync(stack.pop(), { withFileTypes: true, recursive: false })) {
        if (e.isDirectory() && e.name !== "node_modules") {
          const full = path.join(e.parentPath ?? e.path, e.name);
          if (e.name === "migrations") v.push(`${rel(root, full)}: migrations belong in services/<name>/migrations`);
          stack.push(full);
        }
      }
    }
  }
  return v;
}
