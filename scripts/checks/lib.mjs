import fs from "node:fs";
import path from "node:path";

export const rel = (root, file) => path.relative(root, file).split(path.sep).join("/");
export const schemaOf = (service) => service.replace(/-/g, "_");

export function listServices(root) {
  const dir = path.join(root, "services");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function walk(dir, pred = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, pred));
    else if (pred(full)) out.push(full);
  }
  return out.sort();
}

export const isTs = (f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts");
export const read = (f) => fs.readFileSync(f, "utf8");
export const lineCount = (text) => text.replace(/\n$/, "").split("\n").length;
