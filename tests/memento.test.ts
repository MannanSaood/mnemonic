import { test } from "node:test";
import assert from "node:assert/strict";
import { init, memory, sharesLive, step, valueOf, type Action, type State } from "../src/playgrounds/memento/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("memento: the deploy tool's snapshot shares the routes map, so a route rollback restores nothing", () => {
  const s = run(init(), { type: "setUpstream", path: "/api" });
  assert.ok(sharesLive(s, "tool", 0), "tool snapshot points at the live map");
  assert.ok(!sharesLive(s, "memento", 0), "memento holds its own copy");
  const r = run(s, { type: "rollback" });
  assert.equal(valueOf(r, r.tool.live).routes["/api"], "api-v2", "the change survived the rollback");
  assert.equal(valueOf(r, r.memento.live).routes["/api"], "api-v1");
  assert.deepEqual(r.last?.memento, []);
  assert.equal(r.last?.tool[0].key, "/api");
  assert.ok(r.done.includes("route"));
});

test("memento: a timeout change rolls back fine in both, which is why the tool's tests passed", () => {
  const r = run(init(), { type: "timeout", delta: 15 }, { type: "rollback" });
  assert.equal(r.tool.live.timeout, 30);
  assert.equal(r.memento.live.timeout, 30);
  assert.equal(r.tool.wrong, 0);
  assert.ok(r.done.includes("timeout"));
});

test("memento: a field added later is missing from the tool's snapshot", () => {
  const r = run(init(), { type: "shipLimits" }, { type: "setLimit", path: "/api" }, { type: "rollback" });
  assert.equal(r.memento.live.limits?.["/api"], 100);
  assert.equal(r.tool.live.limits?.["/api"], 200, "the tool never saved limits");
  assert.ok(r.done.includes("limit"));
});

test("memento: several edits roll back one by one to the start in the memento design", () => {
  let s = run(init(), { type: "setUpstream", path: "/api" }, { type: "addRoute" }, { type: "removeRoute", path: "/auth" }, { type: "timeout", delta: -10 });
  assert.equal(s.memento.history.length, 4);
  s = run(s, { type: "rollback" }, { type: "rollback" }, { type: "rollback" }, { type: "rollback" });
  assert.deepEqual(valueOf(s, s.memento.live).routes, init().heap[2]);
  assert.equal(s.memento.wrong, 0);
  assert.ok(s.tool.wrong > 0);
  assert.equal(run(s, { type: "rollback" }), s, "nothing left to roll back");
});

test("memento: snapshots cost memory per change, diffs cost replay steps", () => {
  const snap = memory(10, 5000, "snapshot"), diff = memory(10, 5000, "diff"), cp = memory(25, 5000, "checkpoint");
  assert.ok(snap.bytes > 100 * diff.bytes);
  assert.equal(snap.worstRestore, 1);
  assert.equal(diff.worstRestore, 10);
  assert.equal(cp.worstRestore, 10);
});
