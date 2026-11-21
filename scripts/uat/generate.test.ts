import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
      planted: { missing: { date: string; currency: string }; stale: { date: string; currency: string }; outlier: { date: string; currency: string } };
    };
    assert.equal(manifest.files.length, 291);
    assert.equal(manifest.files.filter((f) => f.file.startsWith("gl/gl-")).length, 20);
    assert.equal(manifest.files.filter((f) => f.file.startsWith("rates/rates-")).length, 262);
    assert.equal(manifest.malformedProblems.length, 40);
    assert.equal(new Set(manifest.malformedProblems.map((p) => p.row)).size, 40);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
