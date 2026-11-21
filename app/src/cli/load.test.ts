// CLI arg parsing, exit codes and problem formatting (no database).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KINDS,
  dryRunApp,
  formatOutput,
  parseArgs,
  runLoad,
  type Kind,
} from "./load.ts";
import type { LoadOutcome } from "../loaders/outcome.ts";

describe("parseArgs", () => {
  it("reads kind, file, tenant and defaults --by", () => {
    const p = parseArgs(["executed", "trades.csv", "--tenant", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001"], "cli:test");
    assert.equal(p.kind, "executed");
    assert.equal(p.file, "trades.csv");
    assert.equal(p.tenant, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001");
    assert.equal(p.by, "cli:test");
    assert.equal(p.dryRun, false);
    assert.equal(p.drain, false);
  });

  it("accepts flags and kind options in any order around positionals", () => {
    const p = parseArgs(
      [
        "--dry-run",
        "gl",
        "balances.csv",
        "--tenant",
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001",
        "--chart",
        "MAIN",
        "--as-of",
        "2026-03-09",
        "--source",
        "erp",
        "--by",
        "cli:alice",
        "--drain",
      ],
      "cli:test",
    );
    assert.equal(p.kind, "gl");
    assert.equal(p.dryRun, true);
    assert.equal(p.drain, true);
    assert.equal(p.chart, "MAIN");
    assert.equal(p.asOf, "2026-03-09");
    assert.equal(p.source, "erp");
    assert.equal(p.by, "cli:alice");
  });

  it("rejects unknown kind and unknown option", () => {
    assert.throws(() => parseArgs(["nope", "f.csv", "--tenant", "x"], "cli:t"), /unknown kind/);
    assert.throws(() => parseArgs(["gl", "f.csv", "--tenant", "x", "--control", "c.csv"], "cli:t"), /unknown option/);
  });
});

describe("formatOutput", () => {
  it("maps outcomes to exit codes and caps problems at 50", () => {
    const problems = Array.from({ length: 52 }, (_, i) => ({
      rowNo: i + 1,
      column: "balance",
      message: `bad ${i + 1}`,
    }));
    const invalid = formatOutput("gl", { kind: "INVALID_FILE", problems });
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.lines[0], "gl: INVALID_FILE problems=52");
    assert.equal(invalid.lines.length, 52); // summary + 50 + "and 2 more"
    assert.equal(invalid.lines.at(-1), "and 2 more");
    assert.match(invalid.lines[1]!, /^row 1, column balance: bad 1$/);
    assert.ok(invalid.lines.every((l) => !l.includes("1000.00")), "never prints row contents");

    assert.equal(formatOutput("rates", { kind: "REFUSED", message: "empty load" }).exitCode, 2);
    assert.equal(
      formatOutput("entities", { kind: "HELD", batchId: "b1", reason: "ends too many" }).exitCode,
      4,
    );
    const done: LoadOutcome = { kind: "DONE", status: "DUPLICATE", counts: { created: 0, changed: 0, ended: 0, unchanged: 2 } };
    const applied = formatOutput("currencies", done);
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.lines[0], "currencies: DUPLICATE created=0 changed=0 ended=0 unchanged=2");

    const dry = formatOutput("currencies", done, { dryRun: true });
    assert.equal(dry.exitCode, 0);
    assert.equal(dry.lines[0], "currencies: OK (dry-run)");
  });

  it("omits null row or column from problem lines", () => {
    const out = formatOutput("entities", {
      kind: "INVALID_FILE",
      problems: [{ rowNo: null, column: "extra", message: "unknown column extra" }],
    });
    assert.equal(out.lines[1], "column extra: unknown column extra");
  });
});

describe("runLoad dry-run", () => {
  const tenant = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001";

  it("valid currencies file exits 0 without DATABASE_URL", async () => {
    const result = await runLoad(
      ["currencies", "currencies.csv", "--tenant", tenant, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--dry-run"],
      {},
      {
        defaultBy: "cli:test",
        readFile: async () => "code,is_ndf\nUSD,false\nEUR,false\n",
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines[0], "currencies: OK (dry-run)");
  });

  it("invalid file exits 1 and names row and column", async () => {
    const result = await runLoad(
      ["currencies", "bad.csv", "--tenant", tenant, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--dry-run"],
      {},
      {
        defaultBy: "cli:test",
        readFile: async () => "code,is_ndf\nUS,false\n",
      },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.lines[0]!, /INVALID_FILE/);
    assert.ok(result.lines.some((l) => /row 1/.test(l) && /column code/.test(l)));
  });

  it("missing DATABASE_URL without dry-run exits 3", async () => {
    const result = await runLoad(
      ["executed", "t.csv", "--tenant", tenant],
      {},
      { defaultBy: "cli:test", readFile: async () => "trade_id\n" },
    );
    assert.equal(result.exitCode, 3);
    assert.match(result.lines[0]!, /DATABASE_URL/);
  });

  it("dryRunApp never reaches a real pool", () => {
    const app = dryRunApp();
    assert.ok(app.masterData.commands);
    assert.ok(app.dataSource.commands);
    assert.ok(app.fxRate.commands);
    assert.ok(app.fxTrade.commands);
  });
});

describe("kind coverage", () => {
  it("lists every D5 kind", () => {
    const expected: Kind[] = [
      "entities",
      "hierarchy",
      "accounts",
      "currencies",
      "calendars",
      "exposure-currencies",
      "gl",
      "rates",
      "executed",
    ];
    assert.deepEqual([...KINDS], expected);
  });
});
