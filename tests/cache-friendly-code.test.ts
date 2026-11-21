import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLS, NS, RECORDS, cells, compare, init, ramBytes, split, step, trace,
  type Action, type State,
} from "../src/playgrounds/cache-friendly-code/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const matrix = (rows: 8 | 32, order: "row" | "col", prefetch = false) =>
  run(init(), { type: "rows", value: rows }, { type: "order", value: order }, { type: "prefetch", value: prefetch }, { type: "run" });
const records = (layout: "aos" | "soa", prefetch = false) =>
  run(init(), { type: "workload", value: "records" }, { type: "layout", value: layout }, { type: "prefetch", value: prefetch }, { type: "run" });

test("cache: an address splits into offset, set and tag", () => {
  assert.deepEqual(split(0x1a8), { line: 6, set: 6, tag: 0, offset: 40 });
  assert.deepEqual(split(64 * 8 * 3 + 64 * 2 + 5), { line: 26, set: 2, tag: 3, offset: 5 });
});

test("cache: both orders read every value exactly once", () => {
  for (const order of ["row", "col"] as const) {
    const t = trace({ workload: "matrix", rows: 32, order, layout: "aos" });
    assert.equal(t.length, 32 * COLS);
    assert.equal(new Set(t).size, 32 * COLS);
  }
});

test("cache: row order misses once per 64-byte line, 1 in 8 reads", () => {
  const s = matrix(32, "row");
  assert.equal(s.stats.reads, 512);
  assert.equal(s.stats.misses, 64);
  assert.equal(s.stats.ns, 64 * NS.miss + 448 * NS.hit);
  assert.equal(s.runs.length, 1);
});

test("cache: the predict answer, column order on data bigger than the cache misses on every read", () => {
  const s = matrix(32, "col");
  assert.equal(s.stats.misses, 512);
  assert.equal(s.stats.hits, 0);
  const both = run(matrix(32, "row"), { type: "order", value: "col" }, { type: "run" });
  assert.ok(both.done.colPain);
  const c = compare(both)!;
  assert.ok(c.slow.stats.ns / c.fast.stats.ns > 7, "about 7.5 times slower in this model");
  assert.equal(ramBytes(c.slow.stats), 512 * 64, "a whole line fetched for every 8-byte read");
});

test("cache: when the data fits, column order costs no more than row order", () => {
  const row = matrix(8, "row"), col = matrix(8, "col");
  assert.equal(row.stats.misses, 16);
  assert.equal(col.stats.misses, 16, "only compulsory misses");
  assert.ok(col.done.fits);
});

test("cache: summing one field, struct of arrays misses four times less than array of structs", () => {
  const aos = records("aos"), soa = records("soa");
  assert.equal(aos.stats.misses, RECORDS / 2, "a line holds two 32-byte orders");
  assert.equal(soa.stats.misses, RECORDS / 8, "a line holds eight prices");
  assert.equal(ramBytes(aos.stats), 4 * ramBytes(soa.stats));
  const both = run(aos, { type: "layout", value: "soa" }, { type: "run" });
  assert.ok(both.done.soa);
});

test("cache: the prefetcher hides a sequential walk and cannot help a column walk", () => {
  const row = matrix(32, "row", true);
  assert.equal(row.stats.misses, 1);
  assert.ok(row.stats.ns < matrix(32, "row").stats.ns / 4);
  assert.ok(row.done.prefetch);
  const col = matrix(32, "col", true);
  assert.equal(col.stats.misses, 512, "still a miss on every read");
  assert.ok(col.stats.prefetches > 400, "and bandwidth wasted on lines it never uses");
  const aos = records("aos", true), soa = records("soa", true);
  assert.ok(ramBytes(aos.stats) > 3 * ramBytes(soa.stats), "it hides the wait, not the wasted bytes");
});

test("cache: stepping matches running, and a finished loop restarts cold", () => {
  let s = run(init(), { type: "step", n: 1 });
  assert.equal(s.stats.misses, 1);
  assert.equal(s.last?.result, "miss");
  s = run(s, { type: "step", n: 7 });
  assert.equal(s.stats.misses, 1, "the next 7 reads hit the same line");
  s = run(s, { type: "run" });
  assert.equal(s.stats.misses, 64);
  s = run(s, { type: "step", n: 1 });
  assert.equal(s.pos, 1);
  assert.equal(s.stats.reads, 1);
});

test("cache: clicking cells reads them, and a run with manual reads is not recorded", () => {
  let s = run(init(), { type: "touch", cell: 0 }, { type: "touch", cell: 1 });
  assert.equal(s.stats.misses, 1);
  assert.equal(s.stats.hits, 1);
  s = run(s, { type: "run" });
  assert.equal(s.runs.length, 0);
  assert.equal(run(init(), { type: "touch", cell: cells(init()) }).stats.reads, 0, "out of range is ignored");
  assert.deepEqual(run(s, { type: "reset" }), init());
});
