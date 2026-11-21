import { test } from "node:test";
import assert from "node:assert/strict";
import { DEADLINE, GC_AT, HOG_AT, HOG_MS, SLICE_MS, hogOn, init, simulate, step, type Action, type State } from "../src/playgrounds/preemption/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ticks = (s: State, n: number) => { for (let i = 0; i < n; i++) s = step(s, { type: "tick" }); return s; };

test("preemption: with spare Ps and no GC, cooperative scheduling is fine", () => {
  const r = simulate("coop", 2, false);
  assert.equal(r.worstWaitMs, 0);
  assert.equal(r.late, 0);
});

test("preemption: on Go 1.13 the GC waits for the loop, and every P stops meanwhile", () => {
  let s = run(init(), { type: "mode", mode: "coop" }, { type: "procs", procs: 2 });
  s = ticks(s, GC_AT + 3);
  assert.equal(s.gcPhase, "waiting");
  assert.equal(s.ps[1].stopped, true, "P1 stopped for the GC");
  assert.ok(hogOn(s), "the loop keeps P0");
  const r = simulate("coop", 2, true);
  assert.equal(r.pauseMs, HOG_AT + HOG_MS - GC_AT + 1);
  assert.ok(r.worstWaitMs > 60);
  assert.ok(r.late > 20);
});

test("preemption: signals stop the world within a millisecond and nobody is late", () => {
  for (const procs of [1, 2]) {
    const r = simulate("async", procs, true);
    assert.ok(r.pauseMs !== null && r.pauseMs <= 1, `${procs} Ps`);
    assert.equal(r.late, 0, `${procs} Ps`);
    assert.ok(r.signals > 0);
  }
});

test("preemption: on one P, cooperative scheduling makes requests wait for the whole loop", () => {
  const coop = simulate("coop", 1, false), async = simulate("async", 1, false);
  assert.ok(coop.worstWaitMs >= HOG_MS - 2);
  assert.ok(async.worstWaitMs < DEADLINE);
  assert.ok(async.worstWaitMs >= SLICE_MS - 1, "a request can wait about one slice");
});

test("preemption: sysmon sends a signal about every 10 ms while the loop runs", () => {
  const r = simulate("async", 2, false);
  assert.equal(r.signals, Math.floor((HOG_MS - 1) / SLICE_MS));
});

test("preemption: the old workaround, Gosched per MiB, also bounds the pause but yields far more often", () => {
  const g = simulate("gosched", 2, true), a = simulate("async", 2, true);
  assert.ok(g.pauseMs !== null && g.pauseMs <= 1);
  assert.ok(g.yields > 5 * a.signals);
});

test("preemption: sharing one P costs the loop time", () => {
  assert.ok(simulate("async", 1, true).hogDoneAt > simulate("coop", 1, true).hogDoneAt + 30);
});

test("preemption: the prediction locks once a cooperative GC run is recorded", () => {
  let s = run(init(), { type: "guess", guess: "p1" }, { type: "finish" });
  assert.equal(s.runs.length, 1);
  assert.equal(run(s, { type: "guess", guess: "loop" }).guess, "p1");
  s = run(s, { type: "clear" });
  assert.equal(s.t, 0);
  assert.equal(s.runs.length, 1);
});
