// Tree helpers. Pure: no database.

/** Returns a key that sits on a cycle, or null when every parent chain ends. */
export function findCycle(parents: ReadonlyMap<string, string | null>): string | null {
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let cur: string | null | undefined = start;
    while (cur !== null && cur !== undefined) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      cur = parents.get(cur);
    }
  }
  return null;
}

/** Everything beneath rootId, nearest first. The root is not included. */
export function descendants<T>(items: readonly T[], idOf: (t: T) => string, parentOf: (t: T) => string | null, rootId: string): T[] {
  const children = new Map<string, T[]>();
  for (const it of items) {
    const p = parentOf(it);
    if (p !== null) children.set(p, [...(children.get(p) ?? []), it]);
  }
  const out: T[] = [];
  const seen = new Set<string>([rootId]);
  let level = children.get(rootId) ?? [];
  while (level.length > 0) {
    const next: T[] = [];
    for (const it of level) {
      if (seen.has(idOf(it))) continue;
      seen.add(idOf(it));
      out.push(it);
      next.push(...(children.get(idOf(it)) ?? []));
    }
    level = next;
  }
  return out;
}

/** Everything above startId, nearest first. The start is not included. */
export function ancestors<T>(items: readonly T[], idOf: (t: T) => string, parentOf: (t: T) => string | null, startId: string): T[] {
  const byId = new Map(items.map((it) => [idOf(it), it]));
  const out: T[] = [];
  const seen = new Set<string>([startId]);
  let cur = byId.get(startId);
  while (cur) {
    const p = parentOf(cur);
    if (p === null || seen.has(p)) break;
    const parent = byId.get(p);
    if (!parent) break;
    seen.add(p);
    out.push(parent);
    cur = parent;
  }
  return out;
}
