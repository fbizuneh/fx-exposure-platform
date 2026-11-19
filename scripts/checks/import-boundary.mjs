// Rules 2 and 3: reach another service only through its contract; import its contract, never its internals.
// Also: only shared/kernel is shared, the kernel imports nothing, and contract/ never imports its own src/.
import fs from "node:fs";
import path from "node:path";
import { isTs, listServices, read, rel, walk } from "./lib.mjs";

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

export function specifiers(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

export function check(root) {
  const v = [];
  const services = listServices(root);
  const known = new Set(services);

  const sharedDir = path.join(root, "shared");
  if (fs.existsSync(sharedDir)) {
    for (const e of fs.readdirSync(sharedDir, { withFileTypes: true })) {
      if (e.name !== "kernel") v.push(`shared/${e.name}: only shared/kernel may exist (nothing else is shared)`);
    }
  }

  const sources = [
    ...services.flatMap((s) => walk(path.join(root, "services", s), isTs).map((f) => ({ f, owner: s }))),
    ...walk(path.join(root, "shared", "kernel"), isTs).map((f) => ({ f, owner: "@kernel" })),
  ];

  for (const { f, owner } of sources) {
    const where = rel(root, f);
    const inContract = owner !== "@kernel" && where.startsWith(`services/${owner}/contract/`);
    for (const spec of specifiers(read(f))) {
      const alias = /^@services\/([^/]+)(\/.*)?$/.exec(spec);
      if (alias) {
        const [, name, rest = ""] = alias;
        if (owner === "@kernel") v.push(`${where}: the kernel must not import services ("${spec}")`);
        else if (!known.has(name)) v.push(`${where}: imports unknown service "${name}"`);
        else if (name !== owner && !(rest === "/contract" || rest.startsWith("/contract/"))) {
          v.push(`${where}: imports internals of ${name} ("${spec}"); import "@services/${name}/contract" only`);
        }
        continue;
      }
      if (/^@shared\//.test(spec) && spec !== "@shared/kernel") {
        v.push(`${where}: "${spec}" is not shared; only "@shared/kernel" is`);
        continue;
      }
      if (/^@app(\/|$)/.test(spec)) {
        v.push(`${where}: services and the kernel must not import app/ ("${spec}")`);
        continue;
      }
      if (spec.startsWith(".")) {
        const target = rel(root, path.resolve(path.dirname(f), spec));
        const hit = /^services\/([^/]+)(?:\/(.*))?$/.exec(target);
        if (hit) {
          const [, name, inner = ""] = hit;
          if (owner === "@kernel") v.push(`${where}: the kernel must not import services ("${spec}")`);
          else if (name !== owner && !(inner === "contract" || inner.startsWith("contract/"))) {
            v.push(`${where}: reaches into ${name} internals ("${spec}"); use its contract`);
          } else if (name === owner && inContract && (inner === "src" || inner.startsWith("src/"))) {
            v.push(`${where}: a contract must not import its own src/ ("${spec}")`);
          }
        } else if (/^app(\/|$)/.test(target)) {
          v.push(`${where}: services and the kernel must not import app/ ("${spec}")`);
        } else if (/^shared\//.test(target) && !target.startsWith("shared/kernel")) {
          v.push(`${where}: only shared/kernel is shared ("${spec}")`);
        } else if (target.startsWith("..")) {
          v.push(`${where}: import leaves the repository ("${spec}")`);
        } else if (owner === "@kernel" && !target.startsWith("shared/kernel")) {
          v.push(`${where}: the kernel may import only itself ("${spec}")`);
        }
      }
    }
  }
  return v;
}
