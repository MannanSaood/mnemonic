import { test } from "node:test";
import assert from "node:assert/strict";
import { TESTS, coldStart, flaky, init, runSuite, step, type Action, type State } from "../src/playgrounds/singleton/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("singleton: every test passes when run alone", () => {
  for (const t of TESTS) {
    // A suite of one: find a seed whose order starts with this test and run only one worker,
    // checking the test's own slot, which runs first against the defaults.
    const seed = Array.from({ length: 200 }, (_, i) => i + 1).find((sd) => runSuite("global", 1, false, sd).slots[0].test === t.id)!;
    assert.ok(runSuite("global", 1, false, seed).slots[0].ok, `${t.id} passes alone`);
  }
});

test("singleton: the first run on one worker already fails, and the failure is blamed on another test", () => {
  const s = run(init(), { type: "run" });
  assert.ok(s.last!.failed.length > 0);
  const f = s.last!.slots.find((x) => !x.ok)!;
  assert.ok(f.blame && f.blame !== f.test);
});

test("singleton: without teardown, failures depend on order", () => {
  const s = run(init(), { type: "runMany", times: 10 });
  assert.ok(flaky(s.history).length > 0);
});

test("singleton: teardown fixes one worker but not two", () => {
  const one = run(init(), { type: "teardown" }, { type: "runMany", times: 10 });
  assert.equal(one.history.flatMap((h) => h.failed).length, 0);
  const two = run(init(), { type: "teardown" }, { type: "workers", n: 2 }, { type: "runMany", times: 10 });
  assert.ok(flaky(two.history).length > 0);
});

test("singleton: injected config passes in any order on any number of workers", () => {
  const s = run(init(), { type: "design", design: "injected" }, { type: "workers", n: 4 }, { type: "runMany", times: 10 });
  assert.equal(s.history.flatMap((h) => h.failed).length, 0);
});

test("singleton: a naive lazy init can open several pools; a once-guard opens one", () => {
  const naive = Array.from({ length: 8 }, (_, i) => coldStart("naive", i + 1).pools);
  assert.ok(naive.some((p) => p > 1));
  assert.ok(Array.from({ length: 8 }, (_, i) => coldStart("once", i + 1).pools).every((p) => p === 1));
});
