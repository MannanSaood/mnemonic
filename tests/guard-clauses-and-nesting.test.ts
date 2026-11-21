import { test } from "node:test";
import assert from "node:assert/strict";
import { PATHS, huntShape, init, metrics, render, runTests, step, type Action, type State } from "../src/playgrounds/guard-clauses-and-nesting/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("guards: the nested handler is six deep with cognitive complexity 29", () => {
  const m = metrics(init());
  assert.equal(m.depth, 6);
  assert.equal(m.cognitive, 29);
  assert.equal(m.openAtMain, 6);
  assert.ok(m.farthest > 20, "the method check is far from its 405");
});

test("guards: flattening cuts depth and complexity, but not paths", () => {
  const s = run(init(), { type: "flattenAll" });
  const m = metrics(s);
  assert.equal(m.depth, 0);
  assert.equal(m.cognitive, 6);
  assert.equal(m.helpers, 2);
  assert.equal(m.farthest, 0);
  assert.equal(m.paths, PATHS);
  assert.equal(metrics(init()).paths, PATHS);
});

test("guards: every refactoring step keeps all eight tests green", () => {
  let s = init();
  for (const id of ["method", "type", "sig", "key", "dup", "body"] as const) {
    s = step(s, { type: "guard", id });
    assert.ok(runTests(s).every((r) => r.ok), `after guarding ${id}`);
  }
  s = run(s, { type: "extract", id: "type" }, { type: "extract", id: "sig" });
  assert.ok(runTests(s).every((r) => r.ok));
  assert.equal(s.redRuns, 0);
});

test("guards: one guard at a time lowers depth one level", () => {
  const s = run(init(), { type: "guard", id: "method" });
  assert.equal(metrics(s).depth, 5);
  const lines = render(s);
  assert.ok(lines.some((l) => l.kind === "guard" && l.text.startsWith('if (req.method !== "POST") return reply(405')));
});

test("guards: reordering guards is a behaviour change the tests catch", () => {
  const s = run(init(), { type: "flattenAll" }, { type: "swap" });
  const failed = runTests(s).filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].test.name, "GET with no signature");
  assert.equal(failed[0].got, 401);
  assert.equal(s.redRuns, 1);
});

test("guards: each hunt version has exactly two buggy lines and failing tests", () => {
  for (const v of ["nested", "flat"] as const) {
    assert.equal(render(huntShape(v)).filter((l) => l.buggy).length, 2);
    assert.equal(runTests(huntShape(v)).filter((r) => !r.ok).length, 2);
  }
});

test("guards: the hunt records time and clicks per version", () => {
  let s = run(init(), { type: "hunt", version: "nested", at: 1000 });
  const lines = render(huntShape("nested"));
  const wrong = lines.findIndex((l) => l.kind === "body");
  const right = lines.findIndex((l) => l.buggy);
  s = run(s, { type: "pick", line: wrong, at: 3000 });
  assert.equal(s.hunt.wrong, wrong);
  s = run(s, { type: "pick", line: right, at: 9000 });
  assert.deepEqual(s.hunt.nested, { ms: 8000, clicks: 2 });
  assert.equal(s.hunt.phase, null);
  s = run(s, { type: "guard", id: "method" });
  assert.equal(s.guarded.method, true, "editing works again after the hunt");
});
