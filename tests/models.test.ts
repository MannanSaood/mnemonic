// Run with: npm test  (Node's built-in test runner with TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { init, requestCost, requestDone, step, type Action, type State } from "../src/playgrounds/strategy-checkout/model.ts";
import { computeRoadmap } from "../src/lib/roadmap.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("checkout: editing config first exposes customers to the half-done branch design", () => {
  const s = run(init(), { type: "editPlace", place: "config" }, { type: "editPlace", place: "pay" }, { type: "editPlace", place: "refund" });
  const b = requestCost(s.branch);
  assert.equal(b.deploys, 3);
  assert.equal(b.lines, 5);
  assert.ok(b.lostSales + b.stuckRefunds > 0, "some customer should hit a half-done state");
});

test("checkout: config last is a safe order with no failures", () => {
  const s = run(init(), { type: "editPlace", place: "pay" }, { type: "editPlace", place: "refund" }, { type: "editPlace", place: "config" });
  const b = requestCost(s.branch);
  assert.equal(b.lostSales + b.stuckRefunds, 0);
});

test("checkout: the strategy design adds Klarna in one deploy with no failures", () => {
  const s = run(init(), { type: "addProvider" });
  const c = requestCost(s.strategy);
  assert.equal(c.deploys, 1);
  assert.equal(c.files, 1);
  assert.equal(c.lostSales + c.stuckRefunds, 0);
  assert.ok(s.strategy.lastBatch.some((e) => e.provider === "klarna" && e.ok));
});

test("checkout: PayPal's refund change costs one line in both designs", () => {
  let s = run(init(), { type: "editPlace", place: "pay" }, { type: "editPlace", place: "refund" }, { type: "editPlace", place: "config" }, { type: "addProvider" });
  assert.ok(requestDone(s));
  s = run(s, { type: "next" });
  assert.equal(s.request, 1);
  assert.ok(s.branch.lastBatch.some((e) => e.provider === "paypal" && !e.ok), "PayPal refunds fail before the fix");
  s = run(s, { type: "fixPaypal", side: "branch" }, { type: "fixPaypal", side: "strategy" });
  assert.equal(requestCost(s.branch).lines, 1);
  assert.equal(requestCost(s.strategy).lines, 1);
  assert.ok(requestDone(s));
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
