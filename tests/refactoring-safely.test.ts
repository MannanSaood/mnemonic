import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN, SLIP_STEP, bigBang, code, done, init, runSuite, smallSteps, source, step, type Action, type State } from "../src/playgrounds/refactoring-safely/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const times = (n: number, a: Action): Action[] => Array.from({ length: n }, () => a);

test("refactoring: the legacy function passes all six tests", () => {
  assert.ok(runSuite(0, false).every((r) => r.ok));
});

test("refactoring: every step but the slipped one preserves behaviour", () => {
  for (let i = 0; i <= PLAN.length; i++) assert.ok(runSuite(i, false).every((r) => r.ok), `step ${i}`);
  const bad = runSuite(SLIP_STEP, true).filter((r) => !r.ok);
  assert.deepEqual(bad.map((r) => r.name), ["an order of exactly 50.00 ships free"]);
  assert.equal(bad[0].got, 54.99);
});

test("refactoring: testing after each step catches the slip at step 4, with one suspect", () => {
  let s = init();
  for (let i = 0; i < 3; i++) s = run(s, { type: "apply" }, { type: "test" });
  assert.equal(s.lastGreen, 3);
  s = run(s, { type: "apply" }, { type: "test" });
  assert.equal(s.lastRun!.green, false);
  assert.deepEqual(s.lastRun!.suspects, [SLIP_STEP]);
  assert.ok(s.lastRun!.changed <= 8, "a small diff to look at");
});

test("refactoring: reverting the one suspect lets the reader redo it correctly", () => {
  let s = run(init(), ...times(3, { type: "apply" }), { type: "test" }, { type: "apply" }, { type: "test" }, { type: "revert" });
  assert.equal(s.applied, 3);
  assert.equal(s.learned, true);
  s = run(s, { type: "apply" }, { type: "test" });
  assert.equal(s.lastRun!.green, true);
  s = run(s, { type: "apply" }, { type: "apply" }, { type: "test" });
  assert.ok(done(s));
  assert.ok(code(s).some((l) => l.includes("subtotal < FREE_SHIPPING_FROM")));
});

test("refactoring: the big rewrite goes red with every step a suspect", () => {
  const s = run(init(), { type: "rewrite" }, { type: "test" });
  assert.equal(s.lastRun!.green, false);
  assert.equal(s.lastRun!.suspects.length, PLAN.length);
  assert.ok(s.lastRun!.changed > 15);
  assert.equal(bigBang().suspects, 6);
  assert.equal(smallSteps().suspects, 1);
  assert.ok(bigBang().changed > smallSteps().changed * 3);
});

test("refactoring: reverting a batch does not teach which step was wrong", () => {
  let s = run(init(), { type: "rewrite" }, { type: "test" }, { type: "revert" });
  assert.equal(s.applied, 0);
  assert.equal(s.learned, false);
  assert.equal(s.discarded, PLAN.length);
  s = run(s, ...times(4, { type: "apply" }), { type: "test" });
  assert.equal(s.lastRun!.green, false, "the same slip happens again");
});

test("refactoring: the code shows the slip only in the faulty version", () => {
  assert.ok(source(SLIP_STEP, true).some((l) => l.includes("<= FREE_SHIPPING_FROM")));
  assert.ok(!source(SLIP_STEP, false).some((l) => l.includes("<=")));
});
