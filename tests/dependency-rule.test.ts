import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeDone, inCycle, init, predictRevealed, step, swapCost, testDrags, violations, type Action, type State,
} from "../src/playgrounds/dependency-rule/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const toggle = (id: "ucDriver" | "ucRepo" | "ucWeb" | "entityDb" | "handlerRepo"): Action => ({ type: "toggle", id });

test("dependency rule: the base design has no outward imports and its use case tests with fakes", () => {
  assert.equal(violations([]).length, 0);
  assert.deepEqual(testDrags([]), []);
  assert.deepEqual(inCycle([]), []);
});

test("dependency rule: following the rule, a database or framework swap edits no business file (the predicted answer)", () => {
  for (const id of ["db", "web"] as const) {
    const r = swapCost([], id);
    assert.deepEqual(r.edited, []);
    assert.deepEqual(r.business, []);
  }
  const s = run(init(), { type: "predict", value: "0" }, { type: "swap", swap: "db" });
  assert.ok(predictRevealed(s));
  assert.equal(s.predict, "0");
});

test("dependency rule: one outward import drags the use case into the database swap and its test", () => {
  const r = swapCost(["ucDriver"], "db");
  assert.deepEqual(r.business, ["usecase"]);
  assert.ok(r.retested.includes("handler") && r.retested.includes("mailer"));
  assert.ok(testDrags(["ucDriver"]).includes("driver"));
  assert.equal(violations(["ucDriver"]).length, 1);
});

test("dependency rule: taking the framework's request object ties the use case to the web swap only", () => {
  assert.deepEqual(swapCost(["ucWeb"], "web").business, ["usecase"]);
  assert.deepEqual(swapCost(["ucWeb"], "db").business, []);
});

test("dependency rule: database types in the entity reach the very center", () => {
  const r = swapCost(["entityDb"], "db");
  assert.deepEqual(r.business, ["entity"]);
  assert.ok(r.retested.includes("usecase"));
});

test("dependency rule: a use case that builds its own repository forms an import cycle", () => {
  assert.deepEqual(inCycle(["ucRepo"]).sort(), ["pgrepo", "usecase"]);
  assert.deepEqual(swapCost(["ucRepo"], "db").business, ["usecase"]);
});

test("dependency rule: an adapter-to-adapter import is allowed but still widens the database swap", () => {
  assert.equal(violations(["handlerRepo"]).length, 0);
  const r = swapCost(["handlerRepo"], "db");
  assert.deepEqual(r.edited, ["handler"]);
  assert.deepEqual(r.business, []);
});

test("dependency rule: the challenges complete when played", () => {
  let s = run(init(), toggle("ucDriver"));
  assert.ok(challengeDone(s, "untestable"));
  s = run(s, toggle("entityDb"));
  assert.ok(challengeDone(s, "center"));
  s = run(s, toggle("ucDriver"), toggle("entityDb"), toggle("handlerRepo"), { type: "swap", swap: "db" });
  assert.ok(challengeDone(s, "legal"));
  assert.ok(!challengeDone(s, "clean"), "a swap made with a broken rule is not enough");
  s = run(s, toggle("ucWeb"), { type: "swap", swap: "web" });
  assert.ok(!challengeDone(s, "clean"));
  s = run(s, toggle("ucWeb"), { type: "swap", swap: "db" }, { type: "swap", swap: "web" });
  assert.ok(challengeDone(s, "clean"), "both swaps after the last break cost no business edits");
});

test("dependency rule: clean challenge counts only swaps made after the last break", () => {
  let s = run(init(), { type: "swap", swap: "db" }, { type: "swap", swap: "web" });
  assert.ok(!challengeDone(s, "clean"), "never broke the rule");
  s = run(s, toggle("ucWeb"), { type: "swap", swap: "web" }, toggle("ucWeb"), { type: "swap", swap: "db" }, { type: "swap", swap: "web" });
  assert.ok(challengeDone(s, "clean"));
});

test("dependency rule: reset clears everything", () => {
  const s = run(init(), toggle("ucDriver"), { type: "swap", swap: "db" }, { type: "reset" });
  assert.deepEqual(s, init());
});
