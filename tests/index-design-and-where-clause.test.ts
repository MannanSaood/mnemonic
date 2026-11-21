import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, dayOf, init, isoOf, parseWhere, PRESETS, ROWS, runQuery, step, TABLE_PAGES,
  type Action, type Col, type State,
} from "../src/playgrounds/index-design-and-where-clause/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const q = (text: string) => { const p = parseWhere(text); assert.equal(p.error, null, text); return p.preds; };

test("index: parsing equality, ranges, IN, BETWEEN and wrapped columns", () => {
  const p = q(`tenant_id IN (3, 7) AND created_at BETWEEN '2026-06-01' AND '2026-06-30' AND lower(status) = 'new' AND total_cents > 500`);
  assert.equal(p.length, 4);
  assert.deepEqual(p[0].eq, [3, 7]);
  assert.equal(p[1].lo, dayOf("2026-06-01"));
  assert.equal(p[1].hi, dayOf("2026-06-30"));
  assert.equal(p[2].wrapped, "lower(status)");
  assert.equal(p[3].lo, 501);
  assert.ok(parseWhere("color = 'red'").error);
  assert.ok(parseWhere("status > 'new'").error);
  assert.equal(isoOf(dayOf("2026-12-01")!), "2026-12-01");
});

test("index: equality on leading columns plus one range limit the scan; later columns only filter", () => {
  const preds = q(`tenant_id = 7 AND status = 'new' AND created_at >= '2026-12-01'`);
  assert.deepEqual(classify(["tenant_id", "status", "created_at"], preds, false).accessCols, ["tenant_id", "status", "created_at"]);
  const c = classify(["created_at", "tenant_id", "status"], preds, false);
  assert.deepEqual(c.accessCols, ["created_at"], "the range on the first column stops the access columns");
  assert.deepEqual(c.uses.map((u) => u.use), ["index filter", "index filter", "access"]);
  assert.deepEqual(classify(["status"], q("tenant_id = 7"), false).accessCols, []);
});

test("index: the predicted case, range first scans about 50x more entries for the same rows", () => {
  const s = run(init(), { type: "run" });
  const [a, b] = s.runs!;
  assert.deepEqual(a.index, ["created_at", "tenant_id"]);
  assert.equal(a.returned, b.returned);
  assert.equal(b.entriesScanned, b.returned, "(tenant_id, created_at) reads exactly the matching entries");
  assert.ok(a.entriesScanned >= 30 * a.returned, `${a.entriesScanned} vs ${a.returned}`);
  assert.ok(s.done.includes("rangeFirst"));
  assert.ok(s.done.includes("tight"));
});

test("index: the order of conditions in the WHERE clause does not matter", () => {
  const s1 = run(init(), { type: "run", text: PRESETS[0] });
  const s2 = run(init(), { type: "run", text: PRESETS[1] });
  assert.deepEqual(s1.runs!.map((r) => r.entriesScanned), s2.runs!.map((r) => r.entriesScanned));
});

test("index: a function on the indexed column hides it, and the planner reads the whole table", () => {
  const s = run(init(), { type: "run", text: PRESETS[6] });
  const a = s.runs![0];
  assert.equal(a.plan, "seq");
  assert.equal(a.pagesRead, TABLE_PAGES);
  assert.equal(a.examined, ROWS);
  assert.ok(s.done.includes("function"));
  // the same condition written as a range on the bare column uses the index
  const fixed = runQuery(["created_at", "tenant_id"], q(`created_at = '2026-12-24' AND tenant_id = 7`), "pg17");
  assert.equal(fixed.plan, "index");
  assert.equal(fixed.returned, a.returned);
});

test("index: a condition that matches most rows makes the planner give up on the index", () => {
  const r = runQuery(["status"], q(`status = 'shipped'`), "pg17");
  assert.deepEqual(r.accessCols, ["status"]);
  assert.equal(r.plan, "seq");
  assert.ok(r.costIndex > r.costSeq);
  const rare = runQuery(["status"], q(`status = 'new'`), "pg17");
  assert.equal(rare.plan, "index");
  const s = run(init(), { type: "setIndex", lane: 0, cols: ["status"] }, { type: "run", text: `status = 'shipped'` });
  assert.ok(s.done.includes("giveUp"));
});

test("index: without its leading column an index is unusable before PostgreSQL 18, and skip scan helps only with few leading values", () => {
  const preds = q(`created_at >= '2026-12-01'`);
  const idx: Col[] = ["tenant_id", "created_at"];
  assert.equal(runQuery(idx, preds, "pg17").plan, "seq");
  const r18 = runQuery(idx, preds, "pg18");
  assert.equal(r18.plan, "index");
  assert.equal(r18.skipCol, "tenant_id");
  assert.equal(r18.descents, 50);
  // 365 distinct leading values: too many descents, the table scan wins
  assert.equal(runQuery(["created_at", "tenant_id"], q("tenant_id = 7"), "pg18").plan, "seq");
  const s = run(init(), { type: "engine", engine: "pg18" }, { type: "run", text: `created_at >= '2026-12-01'` });
  assert.ok(s.done.includes("skip"));
});

test("index: editing an index reruns the query; reset clears", () => {
  let s = run(init(), { type: "run" }, { type: "moveCol", lane: 0, at: 0, dir: 1 });
  assert.deepEqual(s.indexes[0], ["tenant_id", "created_at"]);
  assert.equal(s.runs![0].entriesScanned, s.runs![1].entriesScanned);
  s = run(s, { type: "removeCol", lane: 1, at: 0 }, { type: "addCol", lane: 1, col: "status" });
  assert.deepEqual(s.indexes[1], ["created_at", "status"]);
  s = run(s, { type: "reset" });
  assert.equal(s.runs, null);
});
