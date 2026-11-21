import { test } from "node:test";
import assert from "node:assert/strict";
import { init, ripple, step, type Action, type State } from "../src/playgrounds/coupling-and-cohesion/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("coupling: per-warehouse stock touches 3 modules when tangled, 1 when cohesive", () => {
  const s = run(init(), { type: "change", fact: "stock" });
  assert.deepEqual([...s.current!.modules].sort(), ["inventory", "orders", "shipping"]);
  assert.equal(s.history[0].cohesive.modules.length, 1);
});

test("coupling: prices in cents ripple two hops through the derived order total", () => {
  const r = ripple("tangled", [], "price");
  assert.equal(r.maxHop, 2);
  assert.equal(r.modules.length, 4);
  assert.ok(r.hits.some((h) => h.module === "email" && h.hop === 2));
});

test("coupling: tangled tax logic lives outside Pricing (low cohesion)", () => {
  const r = ripple("tangled", [], "tax");
  assert.ok(r.inOwner / r.places < 0.5, "most tax edits are outside the module that owns tax");
  assert.equal(ripple("cohesive", [], "tax").places, 1);
});

test("coupling: a new status still needs real work in Email in the cohesive design", () => {
  assert.deepEqual([...ripple("cohesive", [], "status").modules].sort(), ["email", "orders"]);
});

test("coupling: some changes stay local in both designs", () => {
  assert.equal(ripple("tangled", [], "carrier").modules.length, 1);
  assert.equal(ripple("cohesive", [], "carrier").modules.length, 1);
});

test("coupling: a shortcut brings the ripple back along exactly that reach-in", () => {
  let s = run(init(), { type: "design", design: "cohesive" }, { type: "change", fact: "stock" });
  assert.equal(s.current!.modules.length, 1);
  s = run(s, { type: "shortcut", id: "shipReadsStock" });
  assert.deepEqual([...s.current!.modules].sort(), ["inventory", "shipping"]);
  assert.equal(s.history[0].cohesive.modules.length, 2, "history is re-measured");
  s = run(s, { type: "shortcut", id: "shipReadsStock" });
  assert.equal(s.current!.modules.length, 1);
});

test("coupling: flipping the design re-runs the same change", () => {
  const s = run(init(), { type: "change", fact: "price" }, { type: "design", design: "cohesive" });
  assert.equal(s.current!.fact, "price");
  assert.equal(s.current!.modules.length, 1);
});
