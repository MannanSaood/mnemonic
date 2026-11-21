import { test } from "node:test";
import assert from "node:assert/strict";
import { init, step, type Action, type State } from "../src/playgrounds/dependency-injection/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("di: the hard-wired bench finds no bugs and its answer changes between runs", () => {
  const s = run(init(), { type: "runHard" }, { type: "runHard" }, { type: "runHard" });
  assert.equal(s.hard.found.length, 0);
  assert.equal(s.hard.flaky, 2, "staging grows between runs, so the same test flips");
  assert.equal(s.hard.ms, 3 * 1150);
  assert.ok(s.hard.runs.every((r) => r.clock.includes("21 Nov 2026")), "never January");
});

test("di: a normal month on the injected bench passes, and repeats exactly", () => {
  const s = run(init(), { type: "runInj" }, { type: "runInj" });
  assert.ok(s.inj.runs.every((r) => r.ok));
  assert.equal(s.inj.runs[0].outcome, s.inj.runs[1].outcome);
  assert.match(s.inj.runs[0].outcome, /Oct 2026: 3 invoices, \$1,240\.00/);
});

test("di: a January clock exposes the wrong-year bug", () => {
  const s = run(init(), { type: "clock", clock: "jan" }, { type: "runInj" });
  assert.ok(s.inj.found.includes("january"));
  assert.equal(s.inj.runs[0].ok, false);
});

test("di: an empty month crashes, and a failing source is reported as $0", () => {
  let s = run(init(), { type: "data", data: "empty" }, { type: "runInj" });
  assert.ok(s.inj.found.includes("empty"));
  assert.match(s.inj.runs[0].outcome, /Crashed/);
  s = run(s, { type: "data", data: "down" }, { type: "runInj" });
  assert.ok(s.inj.found.includes("outage"));
  assert.match(s.inj.runs[0].outcome, /\$0\.00/);
});

test("di: three injected runs find all three bugs in milliseconds", () => {
  const s = run(init(),
    { type: "clock", clock: "jan" }, { type: "runInj" },
    { type: "clock", clock: "nov" }, { type: "data", data: "empty" }, { type: "runInj" },
    { type: "data", data: "down" }, { type: "runInj" });
  assert.equal(s.inj.found.length, 3);
  assert.ok(s.inj.ms < 10);
  assert.equal(s.inj.count, 3);
});
