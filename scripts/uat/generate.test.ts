import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toBusinessCalendar, valueDateFor } from "../../services/hedge-recommendation/src/calc.ts";
import { parseGlFile } from "../../services/data-source/src/file.ts";
import { generate } from "./generate.ts";

test("one seed produces identical complete UAT files and a manifest that covers their bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "uat-generator-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await generate(20261120, first);
    await generate(20261120, second);
    const a = await readFile(join(first, "manifest.json"));
    const b = await readFile(join(second, "manifest.json"));
    assert.deepEqual(a, b);
    const manifest = JSON.parse(a.toString("utf8")) as {
      files: { file: string; rows: number; sha256: string }[];
      malformedProblems: { row: number; column: string; kind: string }[];
      planted: { missing: { date: string; currency: string }; stale: { date: string; currency: string }; outlier: { date: string; currency: string }; lateGl: { date: string; file: string; loadAfterCycleStart: boolean } };
    };
    assert.equal(manifest.files.length, 292);
    for (const program of ["BS-ENT", "BS-REG"]) {
      const history = (await readFile(join(first, `executed-history-${program}.csv`), "utf8")).trimEnd().split("\n").slice(1);
      assert.ok(history.length > 100);
      assert.ok(history.every((line) => line.split(",")[14] === program));
    }
    assert.equal(manifest.files.filter((f) => f.file.startsWith("gl/gl-")).length, 20);
    assert.deepEqual(manifest.planted.lateGl, { date: "2026-10-27", file: "gl/gl-2026-10-27.csv", loadAfterCycleStart: true });
    assert.equal(manifest.files.filter((f) => f.file.startsWith("rates/rates-")).length, 262);
    assert.equal(manifest.malformedProblems.length, 40);
    assert.equal(new Set(manifest.malformedProblems.map((p) => p.row)).size, 40);
    assert.deepEqual(manifest.malformedProblems.map((p) => p.row), Array.from({ length: 40 }, (_, i) => i + 1));
    const malformedExpectation = JSON.parse(await readFile("packs/uat/expected/gl-malformed-problems.json", "utf8")) as { problems: { row: number; column: string; kind: string }[] };
    assert.deepEqual(malformedExpectation.problems, manifest.malformedProblems);
    const malformed = parseGlFile(await readFile(join(first, "gl-malformed.csv"), "utf8"));
    assert.deepEqual(malformed.rows, []);
    assert.deepEqual(malformed.problems.map((p) => [p.rowNo, p.column]), manifest.malformedProblems.map((p) => [p.row, p.column]));
    for (const entry of manifest.files) {
      const bytes = await readFile(join(first, entry.file));
      assert.equal(bytes.toString("utf8").trimEnd().split("\n").length - 1, entry.rows, entry.file);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
      assert.deepEqual(bytes, await readFile(join(second, entry.file)), entry.file);
    }
    const gl = (await readFile(join(first, "gl/gl-2026-11-20.csv"), "utf8")).trimEnd().split("\n").slice(1);
    assert.equal(gl.length, 20000);
    const keys = gl.map((line) => {
      const cells = line.split(",");
      return [cells[0], cells[1], cells[2], cells[7]].join("|");
    });
    assert.equal(new Set(keys).size, 20000, "GL entity/account/currency/dimension keys must be unique");
    const missingRates = (await readFile(join(first, `rates/rates-${manifest.planted.missing.date}.csv`), "utf8")).split("\n");
    assert.equal(missingRates.filter((line) => line.startsWith(`${manifest.planted.missing.currency},USD,`)).length, 0);
    const staleRates = (await readFile(join(first, `rates/rates-${manifest.planted.stale.date}.csv`), "utf8")).split("\n");
    assert.equal(staleRates.filter((line) => line.startsWith(`${manifest.planted.stale.currency},USD,`)).length, 5);
    const calendarRows = (await readFile(join(first, "calendars.csv"), "utf8")).trimEnd().split("\n").slice(1).map((line) => line.split(","));
    const calendars = new Map(calendarRows.map((row) => [row[0]!, toBusinessCalendar({ currency: row[0]!, weekendDays: row[1]!.split("|"), coveredThrough: row[2]!, holidays: row[3] ? [{ date: row[3] }] : [] })]));
    const lastRates = (await readFile(join(first, "rates/rates-2026-11-20.csv"), "utf8")).trimEnd().split("\n").slice(1).map((line) => line.split(","));
    for (const row of lastRates.filter((cells) => cells[2] === "FORWARD")) {
      assert.equal(row[4], valueDateFor("2026-11-20", row[3]!, [calendars.get(row[0]!)!, calendars.get("USD")!]), `${row[0]} ${row[3]}`);
    }
    assert.equal(lastRates.find((row) => row[0] === "EUR" && row[3] === "3M")?.[4], "2027-02-23", "the EUR holiday moves the exact 3M value date");

    const knownEntities = new Set((await readFile(join(first, "entities.csv"), "utf8")).trimEnd().split("\n").slice(1).map((line) => line.split(",")[0]));
    const knownAccounts = new Set((await readFile(join(first, "accounts.csv"), "utf8")).trimEnd().split("\n").slice(1).map((line) => line.split(",")[1]));
    const dirty = (await readFile(join(first, "gl-dirty.csv"), "utf8")).trimEnd().split("\n").slice(1);
    const expected = JSON.parse(await readFile("packs/uat/expected/gl-dirty-plants.json", "utf8")) as { expectedByProgram: Record<string, { included: number; excluded: number; blocked: number; independentExclusionReasons: Record<string, number> }> };
    for (const program of ["BS-ENT", "BS-REG"]) {
      const counts = { included: 0, excluded: 0, blocked: 0, independentExclusionReasons: { NONFX: 0, LE45: 0, ACCOUNT_1900: 0 } };
      for (const line of dirty) {
        const [entity, account] = line.split(",");
        if (!knownEntities.has(entity) || !knownAccounts.has(account)) counts.blocked++;
        else if (account!.startsWith("8")) { counts.excluded++; counts.independentExclusionReasons.NONFX++; }
        else if (entity === "LE45") { counts.excluded++; counts.independentExclusionReasons.LE45++; }
        else if (program === "BS-REG" && account === "1900") { counts.excluded++; counts.independentExclusionReasons.ACCOUNT_1900++; }
        else counts.included++;
      }
      const e = expected.expectedByProgram[program]!;
      assert.deepEqual([counts.included, counts.excluded, counts.blocked], [e.included, e.excluded, e.blocked]);
      for (const [reason, count] of Object.entries(e.independentExclusionReasons)) assert.equal(counts.independentExclusionReasons[reason as keyof typeof counts.independentExclusionReasons], count);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
