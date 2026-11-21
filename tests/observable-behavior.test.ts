import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUGS, REFACTORS, init, outcome, predictRevealed, runAll, score, step, challenges,
  type Action, type State,
} from "../src/playgrounds/observable-behavior/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const applyAll = (s: State, ids: string[]) => run(s, ...ids.map((c) => ({ type: "apply", change: c }) as Action), { type: "revert" });

test("observable: both suites pass on today's code", () => {
  const rs = runAll(null, init());
  assert.equal(outcome(rs, "A").red, false);
  assert.equal(outcome(rs, "B").red, false);
});

test("observable: suite A goes red on four of five harmless refactorings, suite B on none", () => {
  const s = applyAll(init(), REFACTORS);
  const sc = score(s);
  assert.equal(sc.refactors, 5);
  assert.equal(sc.falseAlarms.A, 4);
  assert.equal(sc.falseAlarms.B, 0);
  assert.equal(sc.testEdits.A, 6, "r1 and r3 each break two tests");
  assert.equal(outcome(runAll("r5", s), "A").red, false, "moving the guard keeps A6 green: it checks an outcome");
  assert.ok(predictRevealed(s));
});

test("observable: suite A misses the bugs that hide behind its mocks; suite B catches them", () => {
  for (const bug of ["x1", "x2"] as const) {
    const rs = runAll(bug, init());
    assert.equal(outcome(rs, "A").red, false, `${bug}: A stays green`);
    assert.equal(outcome(rs, "B").red, true, `${bug}: B goes red`);
  }
  const both = runAll("x3", init());
  assert.ok(outcome(both, "A").red && outcome(both, "B").red, "a missing guard is seen by both");
});

test("observable: the Iceland bug needs a new behaviour test, not a private-function test", () => {
  let s = applyAll(init(), BUGS);
  let sc = score(s);
  assert.deepEqual([sc.misses.A, sc.misses.B], [2, 1]);
  assert.equal(outcome(runAll("x4", s), "A").red, true, "A tests the private table directly");
  s = run(s, { type: "iceland", on: true });
  sc = score(s);
  assert.equal(sc.misses.B, 0);
  assert.ok(challenges(s).find((c) => c.id === "iceland")!.done);
});

test("observable: apply toggles, revert returns to today's code, reset clears", () => {
  let s = run(init(), { type: "apply", change: "r1" });
  assert.equal(s.active, "r1");
  s = run(s, { type: "apply", change: "r1" });
  assert.equal(s.active, null);
  assert.deepEqual(s.tried, ["r1"]);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
