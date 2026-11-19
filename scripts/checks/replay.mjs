// Rule 5: every receiver is safe to repeat. Structural form: each event handler in
// services/<name>/src/handlers/ names its event key and has a replay test beside it.
import fs from "node:fs";
import path from "node:path";
import { listServices, read, rel, walk } from "./lib.mjs";

export function check(root) {
  const v = [];
  for (const s of listServices(root)) {
    const dir = path.join(root, "services", s, "src", "handlers");
    const handlers = walk(dir, (f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith(".d.ts"));
    for (const h of handlers) {
      const where = rel(root, h);
      const replay = h.replace(/\.ts$/, ".replay.test.ts");
      if (!fs.existsSync(replay)) v.push(`${where}: no replay test (${rel(root, replay)})`);
      if (!/\beventId\b|\bidempotencyKey\b/.test(read(h))) {
        v.push(`${where}: handler never uses eventId or idempotencyKey, so it cannot be safe to repeat`);
      }
    }
  }
  return v;
}
