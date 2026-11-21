import { test } from "node:test";
import assert from "node:assert/strict";
import { REQ_COUNT, WINDOW, init, simulate, step, summary, HOPS, type Action, type State } from "../src/playgrounds/limited-direct-execution-and-context-switch/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("lde: with no timer, a batch job that never traps keeps the CPU and B is never answered", () => {
  const r = simulate(null, "loops");
  assert.equal(r.answered, 0);
  assert.equal(r.worstMs, null);
  assert.equal(r.switches, 0);
  assert.ok(r.traps >= REQ_COUNT, "the network interrupts still trap into the kernel");
});

test("lde: with no timer, a cooperative batch job that yields lets B run", () => {
  const r = simulate(null, "yields");
  assert.equal(r.answered, REQ_COUNT);
  assert.equal(r.involuntary, 0, "every switch is voluntary without a timer");
});

test("lde: any timer gets B answered even when A never yields", () => {
  for (const t of [100, 1000, 4000, 10000, 50000] as const) assert.equal(simulate(t, "loops").answered, REQ_COUNT, `timer ${t}`);
});

test("lde: a long timer interval makes B wait about one interval", () => {
  const r = simulate(50000, "loops");
  assert.ok(r.worstMs! > 40, `${r.worstMs}`);
  assert.ok(simulate(10000, "loops").worstMs! > 8);
});

test("lde: a very short interval spends a large share of the CPU on switching", () => {
  const short = simulate(100, "loops"), mid = simulate(1000, "loops"), long = simulate(10000, "loops");
  assert.ok(short.overhead > 0.2, `${short.overhead}`);
  assert.ok(mid.overhead < 0.05);
  assert.ok(long.overhead < mid.overhead);
  assert.ok(short.aWorkUs < 0.75 * long.aWorkUs, "A loses real work to switching");
});

test("lde: too short an interval is worse for B's response than a moderate one", () => {
  assert.ok(simulate(100, "loops").worstMs! > simulate(1000, "loops").worstMs!);
});

test("lde: a timer tick with nothing else ready is a trap, not a switch", () => {
  const r = simulate(1000, "loops");
  assert.ok(r.traps > r.switches);
});

test("lde: all time is accounted for", () => {
  for (const t of [null, 100, 4000] as const) {
    const r = simulate(t, "loops");
    assert.equal(r.aWorkUs + r.bWorkUs + r.kernelUs + r.warmUs, WINDOW);
  }
});

test("lde: the guided comparison records runs and the summary uses them", () => {
  let s = run(init(), { type: "guess", guess: "slice" }, { type: "timer", timer: null }, { type: "run" });
  assert.equal(s.guess, "slice");
  assert.equal(run(s, { type: "guess", guess: "never" }).guess, "slice", "guess is locked after the no-timer run");
  s = run(s, { type: "timer", timer: 100 }, { type: "run" }, { type: "timer", timer: 50000 }, { type: "run" });
  const sum = summary(s.runs)!;
  assert.equal(sum.short.timer, 100);
  assert.equal(sum.long.timer, 50000);
  assert.ok(sum.stuck);
  assert.equal(sum.best!.timer, 100, "of 100 µs and 50 ms, 100 µs answers B sooner");
  assert.equal(run(s, { type: "reset" }).runs.length, 0);
});

test("lde: the hop stepper cycles through the switch", () => {
  let s = init();
  for (let i = 0; i < HOPS.length; i++) s = step(s, { type: "hop" });
  assert.equal(s.hop, 0);
});
