// Database tests. They need a PostgreSQL database whose name ends in _test, because they reset the
// fx_trade schema. Set TEST_DATABASE_URL (docker compose up -d starts one). Without it they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asOfDate, cycleId, entityId, programId, tenantId, type CycleId, type TenantId } from "@shared/kernel";
import type { Cycle, ProgramSummary } from "@services/exposure-management/contract";
import type { Actor } from "@services/identity/contract";
import type { Entity } from "@services/master-data/contract";
import { migrate } from "../../../scripts/migrate.mjs";
import { AccessDenied, connect, createFxTrade, parseExecutedFile, PreTradeInvalid, type Db, type ExecutedRow, type NewPreTradeBody } from "./index.ts";
import { q } from "./db.ts";
import type { LegInput } from "./model.ts";

const url = process.env.TEST_DATABASE_URL;
const enabled = url !== undefined && /\/[^/?]*_test(\?|$)/.test(url);
if (!enabled) console.warn("fx trade database tests SKIPPED: set TEST_DATABASE_URL to a database whose name ends in _test");
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn);

const ent = (code: string, hedge: boolean): Entity => ({
  entityId: entityId(`id-${code}`), code, name: code, type: "LEGAL_ENTITY", parentEntityId: null, countryCode: null, functionalCurrency: "USD",
  isLegalEntity: true, isTreasuryEntity: false, isHedgeExecutionEntity: hedge,
});
const ENTITIES = new Map([ent("US01", true), ent("DE01", true), ent("PLAIN", false)].map((e) => [e.code, e]));
const cycles = new Map<string, Cycle>();
let deny = false;
const USER: Actor = { kind: "user", userId: "u-1" as never };

const fakes = {
  access: { async checkAccess() { return deny ? ({ allowed: false, reason: "permission-missing" } as const) : ({ allowed: true, via: "user" } as const); } },
  masterData: { async getEntities(_t: TenantId, codes: readonly string[]) { return codes.flatMap((c) => (ENTITIES.has(c) ? [ENTITIES.get(c)!] : [])); } },
  management: {
    async programCatalog(): Promise<readonly ProgramSummary[]> {
      return [{ programId: programId("BS"), name: "BS", type: "BALANCE_SHEET", enabled: true }, { programId: programId("CF"), name: "CF", type: "CASH_FLOW", enabled: false }];
    },
    async getCycle(_t: TenantId, c: CycleId) { return cycles.get(c) ?? null; },
  },
};

let db: Db;
let ft: ReturnType<typeof createFxTrade>;
const clock = new Date("2026-11-09T12:00:00Z");
before(async () => {
  if (!enabled) return;
  db = connect(url!);
  await db.schema.dropSchema("fx_trade").ifExists().cascade().execute();
  await migrate(url!);
  ft = createFxTrade(db, fakes as never, { now: () => clock });
});
after(async () => {
  if (enabled) await db.destroy();
});

const leg = (over: Partial<LegInput> = {}): LegInput => ({ role: "SINGLE", direction: "SELL", dealCurrency: "EUR", dealAmount: "1000000", settlementCurrency: "USD", settlementAmount: null, valueDate: "2026-12-15", fixingDate: null, ...over });
const fwd = (over: Partial<LegInput> = {}, entity = "US01"): NewPreTradeBody => ({ tradingEntityCode: entity, instrument: "FORWARD", legs: [leg(over)] });
function openCycle(t: TenantId, over: Partial<Cycle> = {}): CycleId {
  const c = cycleId(randomUUID());
  cycles.set(c, { cycleId: c, programId: programId("BS"), asOf: asOfDate("2026-11-09"), stage: "COMPLETED", outcome: null, outcomeReason: null, rerunCount: 0, approvedAt: null, approvedBy: null, initiatedBy: "x", initiatedAt: "x", settings: {} as never, history: [], ...over } as Cycle);
  void t;
  return c;
}
const approved = (t: TenantId, c: CycleId) => ({ eventId: randomUUID(), tenantId: t, cycleId: c, programId: programId("BS"), type: "exposure-management.cycle-approved" as const, occurredAt: "x" });
const everything = async (t: TenantId) => (await ft.outbox.pending(1000)).filter((e) => e.tenantId === t);
const events = async (t: TenantId) => (await everything(t)).filter((e) => e.type !== "fx-trade.change-recorded"); // what other services react to
const changes = async (t: TenantId) => (await everything(t)).flatMap((e) => (e.type === "fx-trade.change-recorded" ? [`${e.action} ${e.targetType} by ${e.actor}`] : [])); // what Audit is told

/** A released, sent pre-trade for a forward SELL EUR 1,000,000. */
async function sentPreTrade(t: TenantId, body: NewPreTradeBody = fwd()) {
  const c = openCycle(t);
  const [made] = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: randomUUID(), ...body }], by: "rec" });
  await ft.commands.onCycleApproved(approved(t, c));
  await ft.commands.exportPreTrades({ tenantId: t, actor: USER });
  return { ...made!, c };
}

const HEADER = "trade_id,execution_platform_id,trading_entity,counterparty,trade_date,value_date,deal_currency,deal_amount,settlement_currency,settlement_amount,fixing_date,instrument,buy_sell,hedging_program_id,pre_trade_reference,leg";
const csv = (...lines: string[]): ExecutedRow[] => parseExecutedFile([HEADER, ...lines].join("\n"));
const line = (id: string, over: Partial<Record<string, string>> = {}) => {
  const v = { id, platform: "FXALL", entity: "US01", cp: "Bank", td: "2026-11-10", vd: "2026-12-15", dc: "EUR", da: "1000000", sc: "USD", sa: "1100000", fix: "", ins: "FORWARD", bs: "SELL", prog: "BS", ref: "", leg: "", ...over };
  return [v.id, v.platform, v.entity, v.cp, v.td, v.vd, v.dc, v.da, v.sc, v.sa, v.fix, v.ins, v.bs, v.prog, v.ref, v.leg].join(",");
};
const tenant = () => tenantId(randomUUID());

dbTest("recommended pre-trades are drafts under the cycle, made once per recommendation, all or nothing", async () => {
  const t = tenant();
  const c = openCycle(t);
  const rec = randomUUID();
  const [a] = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: rec, ...fwd() }], by: "rec" });
  assert.equal(a!.created, true);
  const again = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: rec, ...fwd({ dealAmount: "5" }) }], by: "rec" });
  assert.deepEqual([again[0]!.created, again[0]!.preTradeId], [false, a!.preTradeId], "the same recommendation again returns the pre-trade already made");
  const p = (await ft.questions.getPreTrade(t, a!.preTradeId))!;
  assert.deepEqual([p.status, p.cycleId, p.programId, p.origin, p.legs[0]!.dealAmount, p.legs[0]!.settlementAmount], ["DRAFT", c, "BS", "RECOMMENDATION", "1000000.0000", null]);
  assert.match(p.reference, /^PT-[0-9A-F]{12}$/);
  assert.deepEqual(await events(t), [], "a draft announces nothing");

  await assert.rejects(
    ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: randomUUID(), ...fwd() }, { recommendationId: randomUUID(), ...fwd({}, "PLAIN") }], by: "rec" }),
    (e: unknown) => e instanceof PreTradeInvalid && /item 2.*not a hedge execution entity/.test(e.message),
  );
  assert.equal((await ft.questions.preTrades(t, { cycleId: c })).length, 1, "the good item was not made either");
  await assert.rejects(ft.commands.createPreTrades({ tenantId: t, cycleId: openCycle(t, { approvedAt: "2026-11-09" }), items: [{ recommendationId: randomUUID(), ...fwd() }], by: "rec" }), /open cycle that is not approved/);
  await assert.rejects(ft.commands.createPreTrades({ tenantId: t, cycleId: cycleId(randomUUID()), items: [], by: "rec" }), /does not exist/);
  await assert.rejects(ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: randomUUID(), ...fwd({ dealCurrency: "USD" }) }], by: "rec" }), /must differ/);
});

dbTest("one recommendation can have several pre-trades, one per part, made together and once each (decision 0016)", async () => {
  const t = tenant();
  const c = openCycle(t);
  const rec = randomUUID();
  const parts = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [1, 2, 3].map((n) => ({ recommendationId: rec, partNo: n, ...fwd({ dealAmount: String(n * 100) }) })), by: "rec" });
  assert.deepEqual(parts.map((p) => [p.partNo, p.created]), [[1, true], [2, true], [3, true]]);
  const held = await ft.questions.preTrades(t, { cycleId: c });
  assert.deepEqual(held.map((p) => [p.recommendationId === rec, p.partNo, p.legs[0]!.dealAmount]), [[true, 1, "100.0000"], [true, 2, "200.0000"], [true, 3, "300.0000"]], "in part order");
  // Sending it again, or with one part more, returns what exists and makes only the new part.
  const again = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [1, 2, 3, 4].map((n) => ({ recommendationId: rec, partNo: n, ...fwd({ dealAmount: "5" }) })), by: "rec" });
  assert.deepEqual(again.map((p) => [p.partNo, p.created]), [[1, false], [2, false], [3, false], [4, true]]);
  assert.deepEqual(again.slice(0, 3).map((p) => p.preTradeId), parts.map((p) => p.preTradeId));
  // A part that is sent twice in one call, or a bad part number, is refused, and nothing is made.
  const other = randomUUID();
  await assert.rejects(ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: other, partNo: 1, ...fwd() }, { recommendationId: other, partNo: 1, ...fwd() }], by: "rec" }), /part 1 of recommendation .* appears twice/);
  await assert.rejects(ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: other, partNo: 0, ...fwd() }], by: "rec" }), /part number must be a whole number from 1/);
  // Without a part number it is part 1: a caller that does not split is unchanged.
  const [plain] = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: other, ...fwd() }], by: "rec" });
  assert.equal((await ft.questions.getPreTrade(t, plain!.preTradeId))!.partNo, 1);
  assert.equal((await ft.questions.preTrades(t, { cycleId: c })).filter((p) => p.recommendationId === other).length, 1);
  // The database itself holds one pre-trade per recommendation part.
  await assert.rejects(q(db).insertInto("pre_trades").values({ tenant_id: t, pre_trade_id: randomUUID(), reference: "PT-DUP", program_id: "BS", cycle_id: c, recommendation_id: rec, part_no: 2, origin: "RECOMMENDATION", status: "DRAFT", trading_entity_code: "US01", instrument: "FORWARD", released_at: null, sent_at: null, created_by: "x" }).execute(), /duplicate key|unique/);
});

dbTest("approval releases the cycle's drafts once, export sends them once, and a skipped cycle cancels them", async () => {
  const t = tenant();
  const c = openCycle(t);
  const [a, b] = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: "r1", ...fwd() }, { recommendationId: "r2", ...fwd({ direction: "BUY" }, "DE01") }], by: "rec" });
  const e = approved(t, c);
  assert.equal(await ft.commands.onCycleApproved(e), 2);
  assert.equal(await ft.commands.onCycleApproved(e), 0, "the same event again changes nothing");
  assert.deepEqual((await events(t)).map((x) => x.type), ["fx-trade.pre-trade-ready", "fx-trade.pre-trade-ready"]);
  assert.deepEqual((await events(t)).map((x) => (x as { preTradeId: string }).preTradeId).sort(), [a!.preTradeId, b!.preTradeId].sort());

  const out = await ft.commands.exportPreTrades({ tenantId: t, actor: USER });
  assert.equal(out.preTradeIds.length, 2);
  const lines = out.file.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.startsWith(`${a!.reference},BS,US01,FORWARD,,SELL,EUR,1000000.0000,USD,,2026-12-15,`)));
  assert.deepEqual((await ft.questions.preTrades(t, { cycleId: c })).map((p) => p.status), ["SENT", "SENT"]);
  assert.equal((await ft.commands.exportPreTrades({ tenantId: t, actor: USER })).preTradeIds.length, 0, "sent ones are not sent again");

  const t2 = tenant();
  const c2 = openCycle(t2);
  await ft.commands.createPreTrades({ tenantId: t2, cycleId: c2, items: [{ recommendationId: "r1", ...fwd() }], by: "rec" });
  const skipped = { eventId: randomUUID(), tenantId: t2, cycleId: c2, programId: programId("BS"), type: "exposure-management.cycle-skipped" as const, occurredAt: "x", reason: "x" };
  assert.equal(await ft.commands.onCycleClosed(skipped as never), 1);
  assert.equal(await ft.commands.onCycleApproved(approved(t2, c2)), 0, "nothing left to release");
  assert.deepEqual((await ft.questions.preTrades(t2)).map((p) => p.status), ["CANCELLED"]);
});

dbTest("manual pre-trades: permission, enabled program, release by a user; recommendations wait for approval; cancel rules", async () => {
  const t = tenant();
  deny = true;
  await assert.rejects(ft.commands.createManualPreTrade({ tenantId: t, programId: programId("BS"), body: fwd(), actor: USER }), AccessDenied);
  deny = false;
  await assert.rejects(ft.commands.createManualPreTrade({ tenantId: t, programId: programId("CF"), body: fwd(), actor: USER }), /not enabled/);
  const m = await ft.commands.createManualPreTrade({ tenantId: t, programId: programId("BS"), body: fwd(), actor: USER });
  assert.equal((await ft.questions.getPreTrade(t, m.preTradeId))!.status, "DRAFT");
  assert.equal(await ft.commands.releasePreTrade({ tenantId: t, preTradeId: m.preTradeId, actor: USER }), true);
  assert.equal(await ft.commands.releasePreTrade({ tenantId: t, preTradeId: m.preTradeId, actor: USER }), false);
  assert.equal((await events(t)).length, 1);

  const c = openCycle(t);
  const [r] = await ft.commands.createPreTrades({ tenantId: t, cycleId: c, items: [{ recommendationId: "r", ...fwd() }], by: "rec" });
  await assert.rejects(ft.commands.releasePreTrade({ tenantId: t, preTradeId: r!.preTradeId, actor: USER }), /released when its cycle is approved/);

  assert.equal(await ft.commands.cancelPreTrade({ tenantId: t, preTradeId: m.preTradeId, actor: USER }), true);
  assert.equal(await ft.commands.cancelPreTrade({ tenantId: t, preTradeId: m.preTradeId, actor: USER }), false);
  const who = `user:${(USER as { userId: string }).userId}`;
  assert.deepEqual(await changes(t), [`pre-trade.created pre-trade by ${who}`, `pre-trade.released pre-trade by ${who}`, `pre-trade.cancelled pre-trade by ${who}`], "each change once; a repeat or a refusal records nothing");
  const s = await sentPreTrade(t);
  await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("F1", { ref: s.reference })), by: "bank" });
  await assert.rejects(ft.commands.cancelPreTrade({ tenantId: t, preTradeId: s.preTradeId, actor: USER }), /cannot be cancelled/);
});

dbTest("executed trades match by reference, fill in parts, and the pre-trade status follows", async () => {
  const t = tenant();
  const s = await sentPreTrade(t);
  const r1 = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("F1", { ref: s.reference, da: "400000", sa: "440000" })), by: "bank" });
  assert.deepEqual([r1.status, r1.stored, r1.matched, r1.unmatched, r1.blocked], ["APPLIED", 1, 1, 0, 0]);
  let p = (await ft.questions.getPreTrade(t, s.preTradeId))!;
  assert.deepEqual([p.status, p.filledAmount], ["PARTLY_EXECUTED", "400000.0000"]);

  const over = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("F2", { ref: s.reference, da: "700000", sa: "770000" })), by: "bank" });
  assert.equal(over.unmatched, 1, "more than what is still open does not fit");
  const [un] = await ft.questions.unmatchedTrades(t);
  assert.match(un!.matchNote!, /still open/);
  assert.deepEqual(un!.candidates, [s.preTradeId]);

  await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("F3", { ref: s.reference, da: "600000", sa: "660000" })), by: "bank" });
  p = (await ft.questions.getPreTrade(t, s.preTradeId))!;
  assert.deepEqual([p.status, p.filledAmount], ["EXECUTED", "1000000.0000"]);
  const ev = (await events(t)).filter((e) => e.type === "fx-trade.executed-trade-received");
  assert.equal(ev.length, 3);
  assert.equal((ev[0] as { preTradeId: string }).preTradeId, s.preTradeId);
});

dbTest("with no reference exactly one open pre-trade must fit; several are ambiguous; none is unmatched; nothing is dropped", async () => {
  const t = tenant();
  const a = await sentPreTrade(t);
  const one = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("G1")), by: "bank" });
  assert.equal(one.matched, 1);
  assert.equal((await ft.questions.getPreTrade(t, a.preTradeId))!.status, "EXECUTED");

  const t2 = tenant();
  const x = await sentPreTrade(t2);
  const y = await sentPreTrade(t2);
  const amb = await ft.commands.importExecutedTrades({ tenantId: t2, rows: csv(line("G2")), by: "bank" });
  assert.equal(amb.unmatched, 1);
  const [u] = await ft.questions.unmatchedTrades(t2);
  assert.deepEqual([u!.matchStatus, u!.candidates, u!.programId], ["AMBIGUOUS", [x.preTradeId, y.preTradeId].sort(), "BS"]);
  assert.deepEqual((await ft.questions.getPreTrade(t2, x.preTradeId))!.status, "SENT");

  const none = await ft.commands.importExecutedTrades({ tenantId: t2, rows: csv(line("G3", { da: "1", sa: "1", dc: "GBP", sc: "USD" })), by: "bank" });
  assert.equal(none.unmatched, 1);
  const noProgram = await ft.commands.importExecutedTrades({ tenantId: t2, rows: csv(line("G4", { prog: "" }), line("G5", { prog: "NOPE" })), by: "bank" });
  assert.deepEqual([noProgram.stored, noProgram.unmatched], [2, 2]);
  const all = await ft.questions.unmatchedTrades(t2);
  assert.equal(all.length, 4);
  assert.deepEqual(all.filter((x) => x.programId === null).map((x) => x.tradeId).sort(), ["G4", "G5"], "an unknown program leaves the program empty and the trade visible");
  assert.equal((await ft.questions.unmatchedTrades(t2, { programId: programId("BS") })).length, 2);
});

dbTest("bad rows are blocked with their reason and the raw row; good rows in the same file are stored; the same file twice changes nothing", async () => {
  const t = tenant();
  const rows = csv(line("H1"), line("H2", { entity: "NOPE" }), line("H3", { entity: "PLAIN" }), line("H4", { da: "abc" }), line("H5", { ins: "OPTION" }), line("H6", { td: "2026-11-31" }), line("H1"));
  const r = await ft.commands.importExecutedTrades({ tenantId: t, rows, by: "bank" });
  assert.deepEqual([r.received, r.stored, r.blocked], [7, 0, 7], "a trade ID twice in one file blocks both rows");
  const issues = [...(await ft.questions.tradeIssues(t, r.batchId))].sort((a, b) => a.rowNo - b.rowNo);
  assert.deepEqual(issues.map((i) => [i.rowNo, i.code]), [[1, "LEGS"], [2, "ENTITY"], [3, "ENTITY"], [4, "INVALID"], [5, "INSTRUMENT"], [6, "DATE"], [7, "LEGS"]]);

  const good = csv(line("H1"), line("H2", { entity: "NOPE" }));
  const r2 = await ft.commands.importExecutedTrades({ tenantId: t, rows: good, by: "bank" });
  assert.deepEqual([r2.stored, r2.blocked], [1, 1]);
  assert.match((await ft.questions.tradeIssues(t, r2.batchId))[0]!.message, /NOPE is not a hedge execution entity/);
  const dup = await ft.commands.importExecutedTrades({ tenantId: t, rows: good, by: "bank" });
  assert.deepEqual([dup.status, dup.batchId], ["DUPLICATE", r2.batchId]);
  const again = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("H1"), line("H7")), by: "bank" });
  assert.deepEqual([again.stored, again.unchanged], [1, 1], "a known trade with the same content is left alone");
});

dbTest("a changed row is a new version that keeps its pre-trade; a cancel is a new version and the fill drops back", async () => {
  const t = tenant();
  const s = await sentPreTrade(t);
  await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("V1", { ref: s.reference, da: "400000", sa: "440000" })), by: "bank" });
  const amended = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("V1", { ref: s.reference, da: "400000", sa: "441000", cp: "Other bank" })), by: "bank" });
  assert.deepEqual([amended.stored, amended.matched], [1, 1]);
  const open = await ft.questions.executedTrades(t, { programId: programId("BS"), asOf: asOfDate("2026-11-10") });
  assert.deepEqual(open.map((x) => [x.tradeId, x.version, x.counterparty, x.legs[0]!.settlementAmount, x.preTradeId]), [["V1", 2, "Other bank", "441000.0000", s.preTradeId]]);
  assert.equal((await ft.questions.getPreTrade(t, s.preTradeId))!.filledAmount, "400000.0000", "one trade, counted once");
  const versions = await db.withSchema("fx_trade").selectFrom("executed_trades").select(["version", "is_current"]).where("tenant_id", "=", t).orderBy("version").execute();
  assert.deepEqual(versions.map((v) => [v.version, v.is_current]), [[1, false], [2, true]]);

  assert.equal(await ft.commands.cancelExecutedTrade({ tenantId: t, platform: "FXALL", tradeId: "V1", by: "ops" }), true);
  assert.equal(await ft.commands.cancelExecutedTrade({ tenantId: t, platform: "FXALL", tradeId: "V1", by: "ops" }), false);
  assert.deepEqual((await ft.questions.getPreTrade(t, s.preTradeId))!.filledAmount, "0.0000");
  assert.equal((await ft.questions.getPreTrade(t, s.preTradeId))!.status, "SENT");
  assert.deepEqual(await ft.questions.executedTrades(t, { programId: programId("BS"), asOf: asOfDate("2026-11-10") }), [], "a cancelled trade is not open");
});

dbTest("open trades on a date: traded by then, last value date after; a swap stays open until its far leg", async () => {
  const t = tenant();
  const swap = [
    line("S1", { ins: "SWAP", leg: "NEAR", vd: "2026-11-30", bs: "BUY", da: "500000", sa: "550000" }),
    line("S1", { ins: "SWAP", leg: "FAR", vd: "2027-01-29", bs: "SELL", da: "500000", sa: "552000" }),
  ];
  const r = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("O1", { vd: "2026-11-20" }), line("O2", { td: "2026-12-01" }), ...swap), by: "bank" });
  assert.equal(r.stored, 3);
  const ids = async (d: string) => (await ft.questions.executedTrades(t, { programId: programId("BS"), asOf: asOfDate(d) })).map((x) => x.tradeId);
  assert.deepEqual(await ids("2026-11-15"), ["O1", "S1"]);
  assert.deepEqual(await ids("2026-11-20"), ["S1"], "value date reached: no longer open");
  assert.deepEqual(await ids("2026-12-05"), ["S1", "O2"], "ordered by trade date");
  assert.deepEqual(await ids("2027-01-28"), ["S1"]);
  assert.deepEqual(await ids("2027-01-29"), [], "the far leg has settled");
  const [s1] = (await ft.questions.executedTrades(t, { programId: programId("BS"), asOf: asOfDate("2026-12-05") })).filter((x) => x.tradeId === "S1");
  assert.deepEqual(s1!.legs.map((l) => [l.role, l.direction, l.dealAmount, l.settlementAmount, l.valueDate]), [["NEAR", "BUY", "500000.0000", "550000.0000", "2026-11-30"], ["FAR", "SELL", "500000.0000", "552000.0000", "2027-01-29"]]);
});

dbTest("a swap pre-trade matches a two-row swap file and fills whole; an NDF keeps its fixing date", async () => {
  const t = tenant();
  const body: NewPreTradeBody = {
    tradingEntityCode: "US01", instrument: "SWAP",
    legs: [leg({ role: "NEAR", direction: "BUY", valueDate: "2026-11-30", dealAmount: "500000" }), leg({ role: "FAR", direction: "SELL", valueDate: "2027-01-29", dealAmount: "500000" })],
  };
  const s = await sentPreTrade(t, body);
  const rows = csv(
    line("W1", { ins: "SWAP", leg: "NEAR", vd: "2026-11-30", bs: "BUY", da: "500000", sa: "550000", ref: s.reference }),
    line("W1", { ins: "SWAP", leg: "FAR", vd: "2027-01-29", bs: "SELL", da: "500000", sa: "552000", ref: s.reference }),
  );
  assert.equal((await ft.commands.importExecutedTrades({ tenantId: t, rows, by: "bank" })).matched, 1);
  assert.equal((await ft.questions.getPreTrade(t, s.preTradeId))!.status, "EXECUTED");

  const ndf = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("N1", { ins: "NDF", dc: "BRL", sc: "USD", fix: "2026-12-11", vd: "2026-12-15", da: "5000000", sa: "950000" })), by: "bank" });
  assert.equal(ndf.stored, 1);
  const [n] = await ft.questions.unmatchedTrades(t);
  assert.deepEqual([n!.instrument, n!.legs[0]!.fixingDate], ["NDF", "2026-12-11"]);
  const bad = await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("N2", { ins: "NDF", dc: "BRL", da: "1", sa: "1" })), by: "bank" });
  assert.equal(bad.blocked, 1);
});

dbTest("a user settles an ambiguous trade by naming a fitting pre-trade", async () => {
  const t = tenant();
  const x = await sentPreTrade(t);
  const y = await sentPreTrade(t);
  await ft.commands.importExecutedTrades({ tenantId: t, rows: csv(line("M1")), by: "bank" });
  const [u] = await ft.questions.unmatchedTrades(t);
  deny = true;
  await assert.rejects(ft.commands.matchByUser({ tenantId: t, executedTradeId: u!.executedTradeId, preTradeId: y.preTradeId, actor: USER }), AccessDenied);
  deny = false;
  await ft.commands.matchByUser({ tenantId: t, executedTradeId: u!.executedTradeId, preTradeId: y.preTradeId, actor: USER });
  assert.deepEqual((await ft.questions.unmatchedTrades(t)), []);
  assert.equal((await ft.questions.getPreTrade(t, y.preTradeId))!.status, "EXECUTED");
  assert.equal((await ft.questions.getPreTrade(t, x.preTradeId))!.status, "SENT");
  await assert.rejects(ft.commands.matchByUser({ tenantId: t, executedTradeId: u!.executedTradeId, preTradeId: x.preTradeId, actor: USER }), /already matched/);
});

dbTest("one tenant never sees another's pre-trades or executed trades", async () => {
  const a = tenant();
  const b = tenant();
  const s = await sentPreTrade(a);
  await ft.commands.importExecutedTrades({ tenantId: a, rows: csv(line("X1", { ref: s.reference })), by: "bank" });
  assert.deepEqual(await ft.questions.preTrades(b), []);
  assert.equal(await ft.questions.getPreTrade(b, s.preTradeId), null);
  assert.deepEqual(await ft.questions.executedTrades(b, { programId: programId("BS"), asOf: asOfDate("2026-11-10") }), []);
  const other = await ft.commands.importExecutedTrades({ tenantId: b, rows: csv(line("X1", { ref: s.reference })), by: "bank" });
  assert.deepEqual([other.status, other.stored, other.unmatched], ["APPLIED", 1, 1], "the same file for another tenant is its own batch and cannot match the first tenant's pre-trade");
});
