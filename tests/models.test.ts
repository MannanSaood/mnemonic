// Run with: npm test  (Node's built-in test runner with TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { init, step, costOf, type State, type Action } from "../src/playgrounds/strategy-checkout/model.ts";
import { computeRoadmap } from "../src/lib/roadmap.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("switch design: paying with a provider config does not list fails at config", () => {
  const s = run(init("switch"), { type: "select", provider: "klarna" }, { type: "pay" });
  assert.equal(s.log[0].ok, false);
  assert.match(s.log[0].text, /Config rejected/);
});

test("switch design: forgetting the Refund branch charges the customer but cannot refund", () => {
  const s = run(init("switch"),
    { type: "teach", place: "config", provider: "klarna" },
    { type: "teach", place: "pay", provider: "klarna" },
    { type: "select", provider: "klarna" }, { type: "pay" }, { type: "refund" });
  assert.equal(s.log[1].ok, true);
  assert.equal(s.log[0].ok, false);
  assert.match(s.log[0].text, /Refund failed/);
  assert.deepEqual(costOf(s), { text: "3 lines · 2 places edited", value: 0.5, good: false });
});

test("strategy design: one new type makes pay and refund work", () => {
  const s = run(init("strategy"), { type: "addType", provider: "klarna" },
    { type: "select", provider: "klarna" }, { type: "pay" }, { type: "refund" });
  assert.ok(s.log[0].ok && s.log[1].ok);
  assert.equal(costOf(s)?.text, "1 new type · 0 edits");
});

const lesson = (id: string, skills: string[], prerequisites: string[] = [], order = 0) => ({
  id, title: id, skills, prerequisites, order, depths: ["overview", "engineer", "deep"],
}) as never;

test("roadmap: prerequisites come first, depth follows the deepest goal, passed checks are skippable", () => {
  const lessons = [lesson("dp/strategy", ["design"], ["dp/interfaces"], 2), lesson("dp/interfaces", ["oop"], [], 1), lesson("go/sched", ["concurrency"], [], 3)];
  const r = computeRoadmap(
    { id: "x", title: "x", summary: "", goals: [{ skill: "design", depth: "engineer", why: "Reviews." }, { skill: "concurrency", depth: "deep", why: "Workers." }] },
    lessons, { "dp/strategy": ["engineer"] });
  assert.deepEqual(r.nodes.map((n) => n.id), ["dp/interfaces", "dp/strategy", "go/sched"]);
  assert.equal(r.nodes[0].prerequisiteOnly, true);
  assert.equal(r.nodes[1].depth, "engineer");
  assert.equal(r.nodes[1].skippable, true);
  assert.equal(r.nodes[2].depth, "deep");
});
