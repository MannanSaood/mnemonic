import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE, BRANCHLESS, N, PENALTY, compare, flipped, guess, init, makeValues, step,
  type Action, type State,
} from "../src/playgrounds/branch-prediction-and-speculation/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const go = (data: "sorted" | "random" | "periodic" | "alternating", predictor: "static" | "1bit" | "2bit" | "history" = "2bit", code: "branch" | "branchless" = "branch") =>
  run(init(), { type: "data", value: data }, { type: "predictor", value: predictor }, { type: "code", value: code }, { type: "run" });

test("branches: sorted and random hold the same numbers, so every variant computes the same sum", () => {
  assert.deepEqual(makeValues("sorted"), makeValues("random").sort((a, b) => a - b));
  const sums = new Set([go("sorted").sum, go("random").sum, go("random", "1bit").sum, go("random", "2bit", "branchless").sum]);
  assert.equal(sums.size, 1);
});

test("branches: the predict answer, shuffled data runs several times slower than sorted", () => {
  const sorted = go("sorted"), random = go("random");
  assert.ok(sorted.mispredicts <= 2, `sorted: ${sorted.mispredicts} mispredicts, only at the crossover`);
  assert.ok(random.mispredicts > N / 3, `random: ${random.mispredicts} mispredicts`);
  assert.ok(random.cycles / sorted.cycles > 3, `${random.cycles} vs ${sorted.cycles} cycles`);
  assert.equal(sorted.cycles, N * BASE + sorted.mispredicts * PENALTY);
  const both = run(sorted, { type: "data", value: "random" }, { type: "run" });
  assert.ok(both.done.sorted);
  const c = compare(both)!;
  assert.equal(c.slow.data, "random");
});

test("branches: branchless code costs the same on any data and never mispredicts", () => {
  for (const d of ["sorted", "random", "periodic", "alternating"] as const) {
    const s = go(d, "2bit", "branchless");
    assert.equal(s.mispredicts, 0);
    assert.equal(s.cycles, N * BRANCHLESS);
  }
  const s = run(go("random"), { type: "code", value: "branchless" }, { type: "run" });
  assert.ok(s.done.branchless, "much faster than the branchy loop on random data");
  assert.ok(go("sorted").cycles < go("sorted", "2bit", "branchless").cycles, "but a predictable branch is cheaper still");
});

test("branches: a 2-bit counter mispredicts once per loop exit, a 1-bit predictor twice", () => {
  const one = go("periodic", "1bit"), two = go("periodic", "2bit");
  assert.equal(one.mispredicts, 16, "8 exits, each mispredicted, then the next entry too");
  assert.ok(two.mispredicts <= 9, `2-bit: ${two.mispredicts}`);
  const s = run(one, { type: "predictor", value: "2bit" }, { type: "run" });
  assert.ok(s.done.twobit);
});

test("branches: alternating outcomes defeat a counter and are learned with history", () => {
  assert.ok(go("alternating", "2bit").mispredicts >= N / 2);
  const h = go("alternating", "history");
  assert.ok(h.mispredicts <= 3, `history: ${h.mispredicts}`);
  assert.ok(h.done.history);
});

test("branches: random data with a threshold everything passes is perfectly predictable", () => {
  const s = run(init(), { type: "data", value: "random" }, { type: "threshold", value: 0 }, { type: "run" });
  assert.ok(s.mispredicts <= 1);
  assert.ok(s.done.threshold);
});

test("branches: counters saturate and predict from their upper half", () => {
  assert.equal(guess("2bit", [1], 0), false);
  assert.equal(guess("2bit", [2], 0), true);
  assert.equal(guess("static", [0], 0), true);
  let s = run(init(), { type: "data", value: "random" });
  for (let i = 0; i < N; i++) {
    s = run(s, { type: "step", n: 1 });
    assert.ok(s.counters[0] >= 0 && s.counters[0] <= 3);
  }
  assert.equal(s.runs.length, 1, "stepping to the end records a run");
});

test("branches: clicking a bar moves it across the threshold and marks the data edited", () => {
  assert.ok(flipped(200, 128) < 128 && flipped(10, 128) >= 128);
  const s0 = init();
  const s = run(s0, { type: "flip", i: 0 });
  assert.ok((s0.values[0] >= 128) !== (s.values[0] >= 128));
  assert.ok(s.edited);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
