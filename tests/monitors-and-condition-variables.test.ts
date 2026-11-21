import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER, canStep, init, isStalled, revealed, simulate, step, type Action, type State, type Tid,
} from "../src/playgrounds/monitors-and-condition-variables/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const go = (t: Tid, n = 1): Action[] => Array.from({ length: n }, () => ({ type: "step", t }) as Action);

/** C1 waits; P1 puts and signals (waking C1) and unlocks; C2 takes the job. */
const stolen = (s: State) => run(s, ...go("C1", 2), ...go("P1", 5), ...go("C2", 5));

test("monitors: wait releases the lock and puts the thread in the wait set", () => {
  const s = run(init(), ...go("C1", 2));
  assert.equal(s.th.C1.status, "waiting");
  assert.equal(s.holder, null);
  assert.deepEqual(s.waitSet, ["C1"]);
  assert.equal(canStep(s, "C1"), false);
  assert.equal(canStep(s, "P1"), true, "the lock is free for the producer");
});

test("monitors: with if, a woken consumer whose job was taken crashes on the empty queue", () => {
  let s = stolen(init());
  assert.equal(s.th.C1.status, "woken");
  assert.equal(s.queue.length, 0);
  s = run(s, ...go("C1", 2)); // retake the lock, then take() without checking
  assert.equal(s.th.C1.status, "crashed");
  assert.equal(s.stats.crashes, 1);
  assert.equal(s.holder, null, "the crash unwinds and releases the lock");
  assert.ok(s.done.includes("crash"));
  assert.ok(revealed(s));
  assert.equal(ANSWER, "crash");
});

test("monitors: with while, the same schedule makes the consumer check again and wait", () => {
  let s = stolen(run(init(), { type: "guard", guard: "while" }));
  s = run(s, ...go("C1", 2)); // retake the lock, check again
  assert.equal(s.th.C1.status, "waiting");
  assert.equal(s.stats.crashes, 0);
  assert.equal(s.stats.useless, 1, "a wakeup for nothing is counted");
});

test("monitors: a spurious wakeup crashes the if version and is harmless with while", () => {
  let s = run(init(), ...go("C1", 2), { type: "spurious", t: "C1" }, ...go("C1", 2));
  assert.equal(s.th.C1.status, "crashed");
  assert.ok(s.done.includes("spurious"));
  s = run(init(), { type: "guard", guard: "while" }, ...go("C1", 2), { type: "spurious", t: "C1" }, ...go("C1", 2));
  assert.equal(s.th.C1.status, "waiting");
});

test("monitors: while + signal on one condition can put every thread to sleep (lost wakeup)", () => {
  let s = run(init(), { type: "guard", guard: "while" });
  s = run(s, ...go("C1", 2), ...go("C2", 2)); // both consumers wait on the empty queue
  s = run(s, ...go("P1", 5)); // put, signal wakes C1, unlock
  s = run(s, ...go("P1", 2)); // queue is full, so P1 waits: wait set C2, P1
  assert.deepEqual(s.waitSet, ["C2", "P1"]);
  s = run(s, ...go("C1", 5)); // retake, check, take, signal wakes C2 (the oldest), unlock
  assert.equal(s.th.C2.status, "woken");
  assert.equal(s.th.P1.status, "waiting", "the producer was not told the queue has room");
  s = run(s, ...go("C1", 2)); // C1 loops and waits on the empty queue
  s = run(s, ...go("C2", 2)); // C2 checks again and waits
  assert.ok(isStalled(s));
  assert.equal(s.stats.stalls, 1);
  assert.ok(s.done.includes("stall"));
});

test("monitors: broadcast in the same schedule wakes the producer too, and work continues", () => {
  let s = run(init(), { type: "guard", guard: "while" }, { type: "wake", wake: "broadcast" });
  s = run(s, ...go("C1", 2), ...go("C2", 2), ...go("P1", 5), ...go("P1", 2), ...go("C1", 5));
  assert.equal(s.th.P1.status, "woken");
  assert.equal(isStalled(s), false);
});

test("monitors: 1,000 random schedules: only while + broadcast is free of crashes and stalls", () => {
  const ifSig = simulate("if", "signal"), ifBc = simulate("if", "broadcast");
  const wSig = simulate("while", "signal"), wBc = simulate("while", "broadcast");
  assert.ok(ifSig.crashed > 500 && ifBc.crashed > 500);
  assert.equal(wSig.crashed, 0);
  assert.ok(wSig.stalled > 100, `while+signal stalled ${wSig.stalled}`);
  assert.equal(wBc.crashed + wBc.stalled, 0);
  assert.ok(wBc.useless > 0, "broadcast pays with wakeups for nothing");
  const s = run(init(), { type: "guard", guard: "while" }, { type: "wake", wake: "broadcast" }, { type: "batch" });
  assert.ok(s.done.includes("clean"));
});
