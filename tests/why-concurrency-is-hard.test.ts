import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER, BATCH, ORDERS, START, canStep, init, outcomes, play, revealed, simulate, step, type Action, type State,
} from "../src/playgrounds/why-concurrency-is-hard/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const A: Action = { type: "step", t: "A" };
const B: Action = { type: "step", t: "B" };

test("why-concurrency-is-hard: two reads before either write lose one count", () => {
  const s = run(init(), A, B, A, A, B, B);
  assert.equal(s.calls, START + 1);
  assert.equal(s.hand.lost, 1);
  assert.ok(s.trace.some((x) => x.bad), "the overwriting write is marked");
  assert.equal(s.seen.ABAABB, START + 1);
  assert.ok(revealed(s));
});

test("why-concurrency-is-hard: a serial order counts both requests", () => {
  const s = run(init(), A, A, A, B, B, B);
  assert.equal(s.calls, START + 2);
  assert.equal(s.hand.lost, 0);
  assert.equal(revealed(s), false);
});

test("why-concurrency-is-hard: of the 20 orders, only the 2 serial ones are right", () => {
  assert.equal(ORDERS.length, 20);
  const res = outcomes("plain");
  const right = res.filter((o) => o.calls === START + 2).map((o) => o.order);
  assert.deepEqual(right.sort(), ["AAABBB", "BBBAAA"]);
  assert.ok(res.every((o) => o.calls === START + 1 || o.calls === START + 2));
  assert.equal(ANSWER, "two");
});

test("why-concurrency-is-hard: with a lock or an atomic add, only the 2 serial orders can happen, and both are right", () => {
  for (const mode of ["lock", "atomic"] as const) {
    const res = outcomes(mode).filter((o) => o.calls !== null);
    assert.equal(res.length, 2, mode);
    assert.ok(res.every((o) => o.calls === START + 2), mode);
  }
});

test("why-concurrency-is-hard: with the lock, the second thread waits at lock()", () => {
  let s = run(init(), { type: "mode", mode: "lock" }, A, A);
  assert.equal(s.holder, "A");
  assert.equal(canStep(s, "B"), false);
  assert.equal(run(s, B), s, "a blocked step does nothing");
  s = run(s, A, A, A); // add, write, unlock
  assert.equal(s.holder, null);
  s = run(s, B, B, B, B, B);
  assert.equal(s.calls, START + 2);
  // replaying an interleaved order is refused with an explanation
  const r = run(init(), { type: "mode", mode: "lock" }, { type: "replay", order: "ABABAB" });
  assert.match(r.note, /cannot happen/);
});

test("why-concurrency-is-hard: replay plays a whole order and records it", () => {
  const s = run(init(), { type: "replay", order: "AABBAB" });
  assert.equal(s.calls, START + 1);
  assert.equal(s.hand.runs, 1);
  assert.equal(play(init(), "BBBAAA")!.calls, START + 2);
});

test("why-concurrency-is-hard: time slices hide the bug, a coin flip per step exposes it, a lock removes it", () => {
  const slices = simulate("plain", "slices", BATCH, 7);
  const coin = simulate("plain", "coin", BATCH, 7);
  assert.ok(slices.lost > 0 && slices.lost < BATCH * 0.05, `slices lost ${slices.lost}`);
  assert.ok(coin.lost > BATCH * 0.6, `coin lost ${coin.lost}`);
  for (const mode of ["lock", "atomic"] as const) {
    assert.equal(simulate(mode, "coin", BATCH, 7).lost, 0);
    assert.equal(simulate(mode, "slices", BATCH, 7).lost, 0);
  }
  const s = run(init(), { type: "batch", sched: "slices" }, { type: "batch", sched: "slices" });
  assert.equal(s.batches.length, 2);
  assert.equal(s.batches[0].billed, s.batches[0].served - s.batches[0].lost);
});

test("why-concurrency-is-hard: the guess locks once the answer is revealed", () => {
  const s = run(init(), { type: "guess", guess: "half" }, { type: "showAll" }, { type: "guess", guess: "two" });
  assert.equal(s.guess, "half");
});
