import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER, OPENING, canStep, deadlocked, init, livelocked, revealed, simulate, step, waitingFor, type Action, type State,
} from "../src/playgrounds/deadlock-and-liveness/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const T1: Action = { type: "step", t: "T1" };
const T2: Action = { type: "step", t: "T2" };
const tick: Action = { type: "tick" };
const ticks = (s: State, n: number) => { for (let i = 0; i < n; i++) s = step(s, tick); return s; };

test("deadlock: each thread takes its from lock, then both wait for the other's: a cycle", () => {
  const s = run(init(), T1, T2);
  assert.equal(s.holder.A, "T1");
  assert.equal(s.holder.B, "T2");
  assert.equal(waitingFor(s, "T1"), "B");
  assert.equal(waitingFor(s, "T2"), "A");
  assert.ok(deadlocked(s));
  assert.equal(s.deadlocks, 1);
  assert.equal(canStep(s, "T1"), false);
  assert.equal(run(s, T1, T2), s, "blocked threads cannot step");
  assert.ok(revealed(s));
  assert.equal(ANSWER, "forever");
});

test("deadlock: the same code is fine when one thread finishes before the other starts", () => {
  const s = run(init(), T1, T1, T1, T1, T1, T2, T2, T2, T2, T2);
  assert.equal(deadlocked(s), false);
  assert.equal(s.th.T1.transfers + s.th.T2.transfers, 2);
  assert.equal(s.balance.A, OPENING - 50 + 30);
  assert.equal(s.balance.A + s.balance.B, 2 * OPENING);
});

test("deadlock: two cores in lockstep deadlock on the second tick and never move money", () => {
  const s = ticks(init(), 2);
  assert.ok(deadlocked(s));
  const r = simulate("naive", false);
  assert.equal(r.transfers, 0);
  assert.equal(r.deadlocked, true);
});

test("deadlock: locking the lower id first makes the cycle impossible", () => {
  let s = run(init(), { type: "mode", mode: "ordered" }, T1, T2);
  assert.equal(s.holder.A, "T1");
  assert.equal(waitingFor(s, "T2"), "A", "T2 now also wants A first, so it waits holding nothing");
  assert.equal(s.holder.B, null);
  assert.equal(deadlocked(s), false);
  s = ticks(s, 20);
  assert.equal(deadlocked(s), false);
  const r = simulate("ordered", false);
  assert.ok(r.transfers >= 6, `ordered moved ${r.transfers}`);
  assert.equal(s.balance.A + s.balance.B, 2 * OPENING);
});

test("deadlock: try-lock with a fixed backoff livelocks in lockstep; jitter makes progress", () => {
  const fixed = simulate("trylock", false);
  assert.equal(fixed.transfers, 0);
  assert.equal(fixed.deadlocked, false);
  assert.equal(fixed.livelocked, true);
  assert.ok(fixed.retries >= 10);
  const jit = simulate("trylock", true);
  assert.ok(jit.transfers > 0, `jitter moved ${jit.transfers}`);
  assert.equal(jit.livelocked, false);
  let s = run(init(), { type: "mode", mode: "trylock" });
  s = ticks(s, 20);
  assert.ok(livelocked(s));
  assert.equal(deadlocked(s), false);
});

test("deadlock: scripted runs are recorded for comparison, and money is conserved", () => {
  let s = run(init(), { type: "run" }, { type: "mode", mode: "ordered" }, { type: "run" },
    { type: "mode", mode: "trylock" }, { type: "run" }, { type: "jitter", on: true }, { type: "run" });
  assert.deepEqual(s.rows.map((r) => [r.mode, r.jitter, r.deadlocked, r.livelocked]), [
    ["naive", false, true, false], ["ordered", false, false, false], ["trylock", false, false, true], ["trylock", true, false, false],
  ]);
  assert.equal(s.balance.A + s.balance.B, 2 * OPENING);
  s = run(s, { type: "guess", guess: "serial" });
  assert.equal(s.guess, null, "guess locks once revealed");
});
