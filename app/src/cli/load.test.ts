// CLI arg parsing, exit codes and problem formatting (no database).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { ChangeSetInvalid } from "../../../services/master-data/src/index.ts";
import type { App } from "../compose.ts";
import type { LoadOutcome } from "../loaders/outcome.ts";
import {
  KINDS,
  dryRunApp,
  formatOutput,
  parseArgs,
  runLoad,
  type Kind,
} from "./load.ts";

const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001";
const MARKER = "SYNTHETIC_MARKER_XYZ_7c29";

describe("parseArgs", () => {
  it("reads kind, file, tenant and defaults --by", () => {
    const p = parseArgs(["executed", "trades.csv", "--tenant", TENANT], "cli:test");
    assert.equal(p.kind, "executed");
    assert.equal(p.file, "trades.csv");
    assert.equal(p.tenant, TENANT);
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
        TENANT,
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

    const refused = formatOutput("rates", { kind: "REFUSED", message: `entity ${MARKER} bad` });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.lines[0], "rates: REFUSED");
    assert.ok(refused.lines.every((l) => !l.includes(MARKER)));

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

  it("marks a committed load when delivery is incomplete after drain", () => {
    const done: LoadOutcome = {
      kind: "DONE",
      status: "APPLIED",
      counts: { created: 2, changed: 0, ended: 0, unchanged: 0 },
    };
    const out = formatOutput("currencies", done, { drained: 1, deliveryIncomplete: true });
    assert.equal(out.exitCode, 3);
    assert.equal(out.lines[0], "currencies: APPLIED created=2 changed=0 ended=0 unchanged=0 drained=1");
    assert.match(out.lines[1]!, /load committed/);
    assert.match(out.lines[1]!, /delivery did not finish/);
  });
});

describe("runLoad dry-run", () => {
  it("valid currencies file exits 0 without DATABASE_URL", async () => {
    const result = await runLoad(
      ["currencies", "currencies.csv", "--tenant", TENANT, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--dry-run"],
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
      ["currencies", "bad.csv", "--tenant", TENANT, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT", "--dry-run"],
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
      ["executed", "t.csv", "--tenant", TENANT],
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

function appliedApp(apply: () => Promise<unknown>): App {
  const boom = () => {
    throw new Error("unexpected command");
  };
  const commands = new Proxy({}, { get: () => boom });
  return {
    identity: { commands, outbox: { pending: async () => [] } },
    masterData: {
      commands: {
        applyEntities: apply,
        applyHierarchy: apply,
        applyAccounts: apply,
        applyCurrencies: apply,
        applyCalendars: apply,
        applyPairExposureCurrencies: apply,
      },
      outbox: { pending: async () => [] },
    },
    fxRate: { commands, outbox: { pending: async () => [] } },
    dataSource: { commands, outbox: { pending: async () => [] } },
    exposureManagement: { commands, outbox: { pending: async () => [] } },
    exposureAnalysis: { commands, outbox: { pending: async () => [] } },
    fxTrade: { commands, outbox: { pending: async () => [] } },
    hedgeRecommendation: { commands, outbox: { pending: async () => [] } },
    close: async () => {},
  } as unknown as App;
}

describe("runLoad --drain", () => {
  const csv = "code,is_ndf\nUSD,false\nEUR,false\n";
  const argv = [
    "currencies",
    "currencies.csv",
    "--tenant",
    TENANT,
    "--source",
    "md",
    "--as-of",
    "2026-03-09",
    "--mode",
    "SNAPSHOT",
    "--drain",
  ];

  it("successful drain exits 0 and reports drained count", async () => {
    const result = await runLoad(argv, { DATABASE_URL: "postgres://test/db" }, {
      defaultBy: "cli:test",
      readFile: async () => csv,
      composeApp: () =>
        appliedApp(async () => ({
          status: "APPLIED",
          batchId: "b1",
          created: 2,
          changed: 0,
          ended: 0,
          unchanged: 0,
        })),
      drain: async () => 3,
      countUndelivered: async () => ({ pending: 0, failed: 0 }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines[0], "currencies: APPLIED created=2 changed=0 ended=0 unchanged=0 drained=3");
  });

  it("incomplete delivery after drain exits 3 without implying rollback", async () => {
    const result = await runLoad(argv, { DATABASE_URL: "postgres://test/db" }, {
      defaultBy: "cli:test",
      readFile: async () => csv,
      composeApp: () =>
        appliedApp(async () => ({
          status: "APPLIED",
          batchId: "b1",
          created: 2,
          changed: 0,
          ended: 0,
          unchanged: 0,
        })),
      drain: async () => 1,
      countUndelivered: async () => ({ pending: 0, failed: 1 }),
    });
    assert.equal(result.exitCode, 3);
    assert.match(result.lines[0]!, /^currencies: APPLIED /);
    assert.match(result.lines[0]!, /drained=1/);
    assert.match(result.lines[1]!, /load committed/);
    assert.match(result.lines[1]!, /delivery did not finish/);
    assert.ok(result.lines.every((l) => !/roll.?back/i.test(l)));
  });
});

describe("refusal output never prints CSV values", () => {
  it("runLoad omits synthetic marker from REFUSED lines", async () => {
    const result = await runLoad(
      ["entities", "entities.csv", "--tenant", TENANT, "--source", "md", "--as-of", "2026-03-09", "--mode", "SNAPSHOT"],
      { DATABASE_URL: "postgres://test/db" },
      {
        defaultBy: "cli:test",
        readFile: async () =>
          [
            "code,name,type,parent_code,country_code,functional_currency,is_legal_entity,is_treasury_entity,is_hedge_execution_entity",
            `${MARKER},Acme,LEGAL_ENTITY,,US,,true,false,false`,
          ].join("\n"),
        composeApp: () =>
          appliedApp(async () => {
            throw new ChangeSetInvalid([`entity ${MARKER}: a legal entity needs a functional currency`]);
          }),
      },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.lines[0], "entities: REFUSED");
    const joined = result.lines.join("\n");
    assert.equal(joined.includes(MARKER), false);
  });

  it("child process stdout and stderr omit the synthetic marker", async () => {
    // Harness: formatOutput path used by the CLI, printed like main().
    const script = `
      import { formatOutput } from "./app/src/cli/load.ts";
      const out = formatOutput("entities", {
        kind: "REFUSED",
        message: "entity ${MARKER}: a legal entity needs a functional currency",
      });
      for (const line of out.lines) console.log(line);
      process.exitCode = out.exitCode;
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 2);
    assert.match(stdout, /^entities: REFUSED\n$/);
    assert.equal(stdout.includes(MARKER), false);
    assert.equal(stderr.includes(MARKER), false);
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
