import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT, init, step, usage, badness, type Action, type ProcId, type State } from "../src/playgrounds/memory-accounting-reclaim-and-oom/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const alloc = (s: State, proc: ProcId, n: number) => run(s, ...Array.from({ length: n }, () => ({ type: "alloc", proc }) as Action));

test("oom: reaching the limit reclaims page cache first, and the allocation succeeds (predict 1)", () => {
  const s = alloc(init(), "api", 4);
  assert.equal(usage(s), LIMIT);
  assert.ok(s.cold < 300);
  assert.equal(s.events.max, 1);
  assert.equal(s.events.oom_kill, 0);
  assert.equal(s.procs.api.anon, 280 + 4 * 64);
  assert.equal(s.found.cacheFirst, true);
});

test("oom: the kill comes only after all cache is gone", () => {
  let s = init();
  while (s.events.oom_kill === 0) {
    const before = s.hot + s.cold;
    s = step(s, { type: "alloc", proc: "api" });
    if (s.events.oom_kill) assert.ok(before < 64, `cache left before the kill: ${before}`);
  }
  assert.equal(s.hot + s.cold, 0);
  assert.equal(s.events.oom, 1);
  assert.equal(s.procs.api.alive, false);
  assert.equal(s.procs.api.exit, 137);
  assert.equal(s.cacheAtFirstKill, 0);
});

test("oom: the largest process dies, not the one that asked (predict 2)", () => {
  let s = alloc(init(), "api", 8); // cache nearly gone
  s = alloc(s, "worker", 3);
  assert.ok(s.firstKill);
  assert.equal(s.firstKill!.asked, "worker");
  assert.equal(s.firstKill!.victim, "api");
  assert.equal(s.procs.worker.alive, true);
  assert.equal(s.found.notTheAsker, true);
});

test("oom: oom_score_adj steers the kill away from the API", () => {
  let s = run(init(), { type: "adj", proc: "api", adj: -1000 }, { type: "adj", proc: "worker", adj: 500 });
  assert.equal(badness(s, "api"), -Infinity);
  s = alloc(s, "api", 12);
  assert.equal(s.procs.api.alive, true);
  assert.equal(s.procs.worker.alive, false);
  assert.equal(s.found.steered, true);
});

test("oom: page cache alone never triggers a kill", () => {
  const s = run(init(), ...Array.from({ length: 10 }, () => ({ type: "read" }) as Action));
  assert.equal(s.events.oom_kill, 0);
  assert.equal(usage(s), LIMIT);
});

test("oom: memory.high throttles instead of killing", () => {
  const s = alloc(run(init(), { type: "high", on: true }), "api", 9);
  assert.equal(s.events.oom_kill, 0);
  assert.ok(s.events.high > 0);
  assert.ok(s.throttledMs >= 500);
  assert.equal(s.found.throttled, true);
});

test("oom: swap absorbs heap before the kill, and swapped memory still counts toward the score", () => {
  const noSwap = alloc(init(), "api", 10);
  const swap = alloc(run(init(), { type: "swap", on: true }), "api", 10);
  assert.equal(noSwap.events.oom_kill, 1);
  assert.equal(swap.events.oom_kill, 0);
  assert.ok(swap.swappedOut > 0);
  const p = swap.procs.api;
  assert.equal(badness(swap, "api"), p.anon + p.swapped);
});

test("oom: restart keeps settings and found challenges; reset clears all", () => {
  let s = alloc(run(init(), { type: "adj", proc: "worker", adj: 1000 }), "api", 12);
  s = step(s, { type: "restart" });
  assert.equal(s.procs.api.alive, true);
  assert.equal(s.procs.worker.adj, 1000);
  assert.equal(s.found.cacheFirst, true);
  assert.deepEqual(step(s, { type: "reset" }), init());
});
