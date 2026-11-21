import { test } from "node:test";
import assert from "node:assert/strict";
import { compositeCost, init, loopCost, missed, step, targets, type Action, type State } from "../src/playgrounds/composite/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("composite: on the shape the loops were written for, both reports agree", () => {
  const t = init().tree;
  assert.equal(compositeCost(t, "org").total, 4770);
  assert.equal(loopCost(t).total, 4770);
  assert.equal(missed(t).length, 0);
});

test("composite: making ML platform a sub-team of Data silently drops it from the loop report", () => {
  const s = run(init(), { type: "guess", guess: "drops" }, { type: "move", id: "ml", to: "data" });
  assert.ok(s.revealed);
  assert.equal(compositeCost(s.tree, "org").total, 4770);
  assert.equal(loopCost(s.tree).total, 4770 - 2390);
  assert.deepEqual(missed(s.tree).map((n) => n.id).sort(), ["models", "trainer"]);
});

test("composite: a project owned directly by the org is missed by the loops", () => {
  const s = run(init(), { type: "move", id: "shared", to: "org" });
  assert.equal(compositeCost(s.tree, "org").total - loopCost(s.tree).total, 75);
});

test("composite: a cluster is a resource with children; the loops count only its own fee", () => {
  const s = run(init(), { type: "addCluster" });
  assert.equal(compositeCost(s.tree, "org").total, 4770 + 73 + 310 + 180);
  assert.equal(loopCost(s.tree).total, 4770 + 73);
  assert.equal(compositeCost(s.tree, "k8s").total, 563);
});

test("composite: cost() is the same call on a leaf and on a group; a leaf makes one call", () => {
  const t = init().tree;
  assert.deepEqual(compositeCost(t, "api-1"), { total: 140, calls: 1, order: ["api-1"] });
  assert.equal(compositeCost(t, "org").calls, t.length, "one call per node");
});

test("composite: a group cannot be moved inside its own subtree", () => {
  const s = run(init(), { type: "move", id: "data", to: "ml" }, { type: "move", id: "ml", to: "data" });
  assert.match(s.refused ?? "", /inside itself/);
  assert.equal(compositeCost(s.tree, "org").total, 4770);
  assert.ok(!targets(s.tree, "data").some((n) => n.id === "ml"));
});
