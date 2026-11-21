import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { generate } from "./generate.ts";
import { writeExpected } from "./expected.ts";

test("independent UAT results are stable, reconcile per group, and wait for the planted missing rate", async () => {
  const root = await mkdtemp(join(tmpdir(), "uat-expected-"));
  try {
    const generated = join(root, "generated");
    await generate(20261120, generated);
    const first = join(root, "first"), second = join(root, "second");
    const statuses = await writeExpected(generated, "packs/uat/config.json", first);
    await writeExpected(generated, "packs/uat/config.json", second);
    assert.equal(statuses.length, 20);
    assert.equal(statuses.filter((s) => s.status === "COMPLETE").length, 19);
    assert.deepEqual(statuses.find((s) => s.date === "2026-11-12"), { date: "2026-11-12", status: "NO_RATE EUR-USD 2026-11-12", rows: 0 });
    for (const { date } of statuses) assert.deepEqual(await readFile(join(first, `${date}.csv`)), await readFile(join(second, `${date}.csv`)), date);
    assert.deepEqual(await readFile(join(first, "expected-status.json")), await readFile(join(second, "expected-status.json")));
    const lines = (await readFile(join(first, "2026-11-20.csv"), "utf8")).trimEnd().split("\n");
    assert.ok(lines.length > 700);
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      assert.equal(cells.length, 19);
      assert.equal(cells[15], new Decimal(cells[7]!).plus(cells[11]!).toFixed(2), "net currency 1 reconciles");
      assert.equal(cells[16], new Decimal(cells[8]!).plus(cells[12]!).toFixed(2), "net currency 2 reconciles");
      assert.equal(cells[17], new Decimal(cells[9]!).plus(cells[13]!).toFixed(2), "net exposure reconciles");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
