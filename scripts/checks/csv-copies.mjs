// Decision 0024: the four file-reading services keep identical CSV readers.
// master-data, data-source and fx-rate hold theirs in src/csv.ts; fx-trade's
// still lives in src/file.ts. This check compares the reader bodies so a
// one-sided edit fails the build.
import fs from "node:fs";
import path from "node:path";
import { read, rel } from "./lib.mjs";

const STANDALONE = [
  "services/master-data/src/csv.ts",
  "services/data-source/src/csv.ts",
  "services/fx-rate/src/csv.ts",
];
const EMBEDDED = "services/fx-trade/src/file.ts";
const SERVICES = ["master-data", "data-source", "fx-rate", "fx-trade"];

/** Drop leading // comments and blank lines so the shared body can be compared. */
export function stripLeadingComments(text) {
  return normalize(text.replace(/^(?:\/\/[^\n]*\n)+/, "").replace(/^\n+/, ""));
}

/** Trailing blank lines do not count as part of the reader. */
function normalize(text) {
  return text.replace(/\s+$/, "\n");
}

/** The splitCsv export as it appears in fx-trade's file.ts. */
export function extractEmbedded(text) {
  const start = text.indexOf("/** Comma-separated text with quotes.");
  if (start < 0) return null;
  const end = text.indexOf("\n/** Header names", start);
  if (end < 0) return null;
  return normalize(text.slice(start, end + 1));
}

export function check(root) {
  const present = SERVICES.filter((s) => fs.existsSync(path.join(root, "services", s)));
  if (present.length === 0) return [];
  const v = [];
  if (present.length !== SERVICES.length) {
    v.push(
      `decision 0024: CSV reader copies expected in ${SERVICES.join(", ")}; found only ${present.join(", ") || "(none)"}`,
    );
    return v;
  }

  const bodies = [];
  for (const p of STANDALONE) {
    const full = path.join(root, p);
    if (!fs.existsSync(full)) {
      v.push(`${p}: missing (decision 0024; one of four identical CSV readers)`);
      continue;
    }
    const text = read(full);
    if (!text.startsWith("// One of four identical CSV readers")) {
      v.push(`${rel(root, full)}: missing the one-line "one of four" comment`);
    }
    bodies.push({ where: p, body: stripLeadingComments(text) });
  }

  const embeddedPath = path.join(root, EMBEDDED);
  if (!fs.existsSync(embeddedPath)) {
    v.push(`${EMBEDDED}: missing (decision 0024; holds fx-trade's CSV reader)`);
  } else {
    const body = extractEmbedded(read(embeddedPath));
    if (body === null) {
      v.push(`${EMBEDDED}: could not find splitCsv (decision 0024)`);
    } else {
      bodies.push({ where: EMBEDDED, body });
    }
  }

  if (bodies.length < 2) return v;
  const [first, ...rest] = bodies;
  for (const other of rest) {
    if (other.body !== first.body) {
      v.push(
        `decision 0024: CSV reader in ${other.where} differs from ${first.where}; change all four together`,
      );
    }
  }
  return v;
}
