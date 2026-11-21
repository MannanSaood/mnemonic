import { test } from "node:test";
import assert from "node:assert/strict";
import { BURST, PROCS, ideal, init, simulate, stealOrder, step, type Action, type State } from "../src/playgrounds/work-stealing/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ticks = (s: State, n: number) => { for (let i = 0; i < n; i++) s = step(s, { type: "tick" }); return s; };

test("stealing: the burst starts all on P0", () => {
  const s = init();
  assert.equal(s.ps[0].q.length, BURST);
  for (let p = 1; p < PROCS; p++) assert.ok(s.ps[p].q.length < 4);
});

test("stealing: with stealing off, P0 does the whole burst alone while the others idle", () => {
  const r = simulate("off");
  assert.equal(r.makespan, 64);
  assert.equal(r.steals, 0);
  assert.ok(r.idleWhileWaiting > 150);
});

test("stealing: stealing half finishes within a millisecond of a perfect split", () => {
  const r = simulate("half");
  const best = ideal(init());
  assert.equal(best, 19);
  assert.ok(r.makespan <= best + 1, String(r.makespan));
  assert.equal(r.idleWhileWaiting, 0);
});

test("stealing: a thief takes half the victim's queue, rounded up, from the head", () => {
  let s = run(init(), { type: "mode", mode: "half" });
  s = ticks(s, BURST); // until a quiet P runs dry and steals
  const first = s.steals[0];
  assert.ok(first, "someone stole");
  assert.equal(first.victim, 0);
  assert.ok(first.n >= 14 && first.n <= 16, `took ${first.n}`);
});

test("stealing: one at a time reaches the same finish but needs far more steals", () => {
  const half = simulate("half"), one = simulate("one");
  assert.ok(Math.abs(one.makespan - half.makespan) <= 1);
  assert.ok(one.steals >= 2 * half.steals, `${one.steals} vs ${half.steals}`);
});

test("stealing: from a burst, stealing matches a batch that was spread evenly from the start", () => {
  assert.equal(simulate("half", "even", "burst").makespan, simulate("off", "even", "spread").makespan);
});

test("stealing: uneven jobs leave a spread batch unbalanced, and stealing fixes it", () => {
  const off = simulate("off", "uneven", "spread"), half = simulate("half", "uneven", "spread");
  assert.ok(off.makespan > half.makespan);
  assert.ok(off.idleWhileWaiting > 0);
});

test("stealing: steal order covers every other P and changes over time", () => {
  for (let p = 0; p < PROCS; p++) {
    const o = stealOrder(p, 0);
    assert.equal(o.length, PROCS - 1);
    assert.ok(!o.includes(p));
  }
  assert.notDeepEqual(stealOrder(1, 0), stealOrder(1, 1));
});

test("stealing: runs are recorded, the guess locks, clear keeps the runs", () => {
  let s = run(init(), { type: "guess", guess: "60" }, { type: "finish" });
  s = run(s, { type: "mode", mode: "half" }, { type: "finish" });
  assert.equal(s.runs.length, 2);
  assert.equal(run(s, { type: "guess", guess: "20" }).guess, "60");
  assert.equal(run(s, { type: "clear" }).t, 0);
  assert.equal(run(s, { type: "reset" }).runs.length, 0);
});
