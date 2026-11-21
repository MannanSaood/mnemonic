import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeDone, init, simulate, step, type Action, type Config, type State } from "../src/playgrounds/caching-strategies/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const cfg = (c: Partial<Config> = {}): Config => ({ pattern: "aside", ttl: 5, invalidate: "ttl", coalesce: false, early: false, lease: false, race: false, ...c });

test("caching: each expiry of a hot key sends about 60 queries with plain cache-aside (the predict answer)", () => {
  const m = simulate(cfg()).summary;
  assert.equal(m.peakQueries, 60);
  assert.ok(m.hits / m.reads > 0.9, "the hit ratio still looks great");
});

test("caching: single-flight, read-through and early refresh each turn the herd into one query", () => {
  assert.equal(simulate(cfg({ coalesce: true })).summary.peakQueries, 1);
  assert.equal(simulate(cfg({ pattern: "through" })).summary.peakQueries, 1);
  const early = simulate(cfg({ ttl: 2, early: true })).summary;
  assert.ok(early.peakQueries <= 2);
  assert.equal(early.hits, early.reads, "with early refresh no reader ever misses");
});

test("caching: TTL-only invalidation serves the old price after a write, longer with a longer TTL", () => {
  const short = simulate(cfg({ ttl: 2 })).summary, long = simulate(cfg({ ttl: 15 })).summary;
  assert.ok(short.stale > 0);
  assert.ok(long.longestStale > short.longestStale);
});

test("caching: delete on write keeps the cache fresh when no refill is in flight", () => {
  for (const ttl of [2, 5, 15] as const) {
    const m = simulate(cfg({ ttl, invalidate: "delete" })).summary;
    assert.equal(m.stale, 0, `ttl ${ttl}`);
    assert.equal(m.raced, false);
  }
});

test("caching: a write during a refill leaves the old price in the cache for a whole TTL when loads are coalesced", () => {
  const { summary, log } = simulate(cfg({ ttl: 15, invalidate: "delete", coalesce: true, race: true }));
  assert.equal(summary.raced, true);
  assert.ok(summary.longestStale >= 14, `stale for ${summary.longestStale} s`);
  assert.ok(log.some((e) => !e.ok && e.text.includes("before the write")));
});

test("caching: without coalescing, later misses overwrite the stale fill almost at once", () => {
  const m = simulate(cfg({ ttl: 15, invalidate: "delete", race: true })).summary;
  assert.equal(m.raced, true);
  assert.ok(m.longestStale <= 0.2);
});

test("caching: write-through has the same race with a concurrent refill", () => {
  const m = simulate(cfg({ pattern: "write-through", ttl: 15, race: true })).summary;
  assert.equal(m.raced, true);
  assert.ok(m.longestStale >= 14);
});

test("caching: leases refuse the stale fill, so no reader sees the old price", () => {
  for (const pattern of ["aside", "through", "write-through"] as const) {
    const m = simulate(cfg({ pattern, ttl: 15, invalidate: "delete", coalesce: true, race: true, lease: true })).summary;
    assert.equal(m.raced, false, pattern);
    assert.equal(m.refused, 1, pattern);
    assert.equal(m.stale, 0, pattern);
  }
});

test("caching: runs are kept for comparison, newest first, at most six", () => {
  let s = init();
  for (let i = 0; i < 7; i++) s = step(s, { type: "run" });
  assert.equal(s.runs.length, 6);
  assert.equal(s.runs[0].id, 7);
  assert.equal(s.shown, 7);
});

test("caching: the prediction locks once made", () => {
  const s = run(init(), { type: "predict", value: "1" }, { type: "predict", value: "60" });
  assert.equal(s.prediction, "1");
});

test("caching: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "run" },                                                                       // herd
    { type: "set", patch: { ttl: 2, coalesce: true } }, { type: "run" },                    // calm
    { type: "set", patch: { ttl: 15, invalidate: "delete", race: true } }, { type: "run" }, // stuck
    { type: "set", patch: { lease: true } }, { type: "run" });                              // fresh
  for (const id of ["herd", "calm", "stuck", "fresh"] as const) assert.ok(challengeDone(s, id), id);
});
