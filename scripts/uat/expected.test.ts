import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { generate } from "./generate.ts";
import { writeExpected } from "./expected.ts";

type CurrencyTotals = Record<string, { rows: number; balance: string }>;
type DirtyResult = { storedRows: number; batchControlTotals: CurrencyTotals; byProgram: Record<string, { included: CurrencyTotals; excluded: CurrencyTotals; blocked: CurrencyTotals; byReason: Record<string, CurrencyTotals> }> };

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
    assert.deepEqual(await readFile(join(first, "gl-dirty-expected.json")), await readFile(join(second, "gl-dirty-expected.json")));
    for (const file of [...statuses.map(({ date }) => `${date}.csv`), "expected-status.json", "gl-dirty-expected.json"]) {
      const current = (await readFile(join(first, file), "utf8")).replaceAll("\r\n", "\n");
      const committed = (await readFile(join("packs/uat/expected", file), "utf8")).replaceAll("\r\n", "\n");
      assert.equal(current, committed, `committed expected file ${file} is stale; run npm run uat:expected`);
    }
    const dirty = JSON.parse(await readFile(join(first, "gl-dirty-expected.json"), "utf8")) as DirtyResult;
    const count = (byCurrency: Record<string, { rows: number }>) => Object.values(byCurrency).reduce((sum, item) => sum + item.rows, 0);
    assert.equal(dirty.storedRows, 20000);
    assert.equal(count(dirty.batchControlTotals), 20000);
    for (const [program, expected] of Object.entries({ "BS-ENT": [18558, 1422, 20], "BS-REG": [17890, 2090, 20] })) {
      const result = dirty.byProgram[program]!;
      assert.deepEqual([count(result.included), count(result.excluded), count(result.blocked)], expected);
      assert.equal(count(result.byReason.GL_ENTITY_UNKNOWN!), 10);
      assert.equal(count(result.byReason.GL_ACCOUNT_UNKNOWN!), 10);
    }
    const config = JSON.parse(await readFile("packs/uat/config.json", "utf8")) as { tenants: { program: { id: string; mappingRules: { kind: string; entityCode?: string; target: { nodeCode?: string } }[] } }[] };
    for (const tenant of config.tenants) tenant.program.mappingRules = tenant.program.mappingRules.filter((rule) => !(rule.kind === "EXCLUDE" && rule.entityCode === "LE45" && rule.target.nodeCode === "FX"));
    const changedConfig = join(root, "without-le45-exclusion.json");
    await writeFile(changedConfig, JSON.stringify(config));
    const changedOutput = join(root, "changed");
    await writeExpected(generated, changedConfig, changedOutput);
    const changed = JSON.parse(await readFile(join(changedOutput, "gl-dirty-expected.json"), "utf8")) as DirtyResult;
    assert.deepEqual(changed.batchControlTotals, dirty.batchControlTotals, "received control totals do not depend on program mappings");
    for (const program of ["BS-ENT", "BS-REG"]) {
      const before = dirty.byProgram[program]!, after = changed.byProgram[program]!, le45 = before.byReason.LE45!;
      assert.equal(count(le45), 422);
      assert.equal(count(after.included) - count(before.included), 422);
      assert.equal(count(before.excluded) - count(after.excluded), 422);
      assert.deepEqual(after.blocked, before.blocked);
      assert.equal(after.byReason.LE45, undefined);
      for (const [currency, amount] of Object.entries(le45)) {
        assert.equal(new Decimal(after.included[currency]?.balance ?? 0).minus(before.included[currency]?.balance ?? 0).toFixed(2), amount.balance);
        assert.equal(new Decimal(before.excluded[currency]?.balance ?? 0).minus(after.excluded[currency]?.balance ?? 0).toFixed(2), amount.balance);
      }
    }
    const hierarchyPath = join(generated, "hierarchy.csv"), accountsPath = join(generated, "accounts.csv"), dirtyPath = join(generated, "gl-dirty.csv");
    await writeFile(hierarchyPath, `${(await readFile(hierarchyPath, "utf8")).trimEnd()}\nUAT,OUTSIDE,Outside the balance sheet,ASSETS,\n`);
    await writeFile(accountsPath, `${(await readFile(accountsPath, "utf8")).trimEnd()}\nUAT,9999,Unmapped FX account,BALANCE_SHEET,DEBIT,true,true,OUTSIDE\n`);
    const dirtyLines = (await readFile(dirtyPath, "utf8")).trimEnd().split("\n");
    const chosen = dirtyLines.findIndex((line, index) => index > 0 && line.startsWith("LE01,") && line.split(",")[1] !== "1900" && !line.split(",")[1]!.startsWith("8"));
    assert.ok(chosen > 0, "test needs a known FX-relevant row included by both programs");
    const cells = dirtyLines[chosen]!.split(","), currency = cells[2]!, signedBalance = cells[3]!;
    cells[1] = "9999";
    dirtyLines[chosen] = cells.join(",");
    await writeFile(dirtyPath, `${dirtyLines.join("\n")}\n`);
    const unmatchedOutput = join(root, "unmatched");
    await writeExpected(generated, "packs/uat/config.json", unmatchedOutput);
    const unmatched = JSON.parse(await readFile(join(unmatchedOutput, "gl-dirty-expected.json"), "utf8")) as DirtyResult;
    assert.deepEqual(unmatched.batchControlTotals, dirty.batchControlTotals, "changing a mapped account to an unmapped one preserves received currency totals");
    for (const program of ["BS-ENT", "BS-REG"]) {
      const before = dirty.byProgram[program]!, after = unmatched.byProgram[program]!;
      assert.equal(count(before.included) - count(after.included), 1);
      assert.equal(count(after.blocked) - count(before.blocked), 1);
      assert.deepEqual(after.excluded, before.excluded);
      assert.deepEqual(after.byReason.GL_PROGRAM_UNMATCHED, { [currency]: { rows: 1, balance: signedBalance } });
      assert.equal(new Decimal(before.included[currency]?.balance ?? 0).minus(after.included[currency]?.balance ?? 0).toFixed(2), signedBalance);
      assert.equal(new Decimal(after.blocked[currency]?.balance ?? 0).minus(before.blocked[currency]?.balance ?? 0).toFixed(2), signedBalance);
    }
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
