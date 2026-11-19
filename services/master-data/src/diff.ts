// Works out what a change set does to what is open on its date. Pure: no database.
import type { Mode } from "./rows.ts";

/** JSON with sorted keys, so equal attribute sets compare equal. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface OpenRow {
  readonly id: string;
  readonly validFrom: string;
  readonly source: string;
  /** Attributes as stable JSON, with references already turned back into codes. */
  readonly attrs: string;
}

export interface Plan {
  readonly creates: string[];
  readonly changes: string[];
  readonly ends: string[];
  readonly unchanged: number;
}

/**
 * incoming maps each key to its attributes (stable JSON). A snapshot also ends the open rows of the
 * same source that it no longer lists; a partial change set never ends anything.
 */
export function plan(open: ReadonlyMap<string, OpenRow>, incoming: ReadonlyMap<string, string>, mode: Mode, source: string): Plan {
  const creates: string[] = [];
  const changes: string[] = [];
  const ends: string[] = [];
  let unchanged = 0;
  for (const [key, attrs] of incoming) {
    const cur = open.get(key);
    if (!cur) creates.push(key);
    else if (cur.attrs !== attrs) changes.push(key);
    else unchanged++;
  }
  if (mode === "SNAPSHOT") {
    for (const [key, cur] of open) if (cur.source === source && !incoming.has(key)) ends.push(key);
  }
  return { creates, changes, ends, unchanged };
}

export const MIN_OPEN_FOR_SAFEGUARD = 10;
export const DEFAULT_MAX_END_SHARE = 0.2;

/** True when a snapshot would end too large a share of what the source has open. */
export function shouldHold(openForSource: number, endCount: number, maxEndShare: number): boolean {
  return endCount > 0 && openForSource >= MIN_OPEN_FOR_SAFEGUARD && endCount / openForSource > maxEndShare;
}
