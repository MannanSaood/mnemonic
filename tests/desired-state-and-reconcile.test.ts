import { test } from "node:test";
import assert from "node:assert/strict";
import { EVICT_AFTER, NOT_READY_AFTER, active, atDesired, deletionOrder, init, ready, step, type Action, type State } from "../src/playgrounds/desired-state-and-reconcile/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const wait = (s: State, seconds: number) => { for (let i = 0; i < seconds; i++) s = step(s, { type: "tick", seconds: 1 }); return s; };
const pod = (s: State, side: "script" | "loop", i = 0) => active(s.lanes[side])[i].name;

test("reconcile: with nothing lost, both sides replace a deleted pod", () => {
  let s = run(init(), { type: "deletePod", side: "loop", name: "worker-1" });
  s = wait(s, 10);
  assert.ok(atDesired(s, s.lanes.loop));
  assert.ok(atDesired(s, s.lanes.script));
  assert.equal(s.found.replaced, true);
  assert.equal(s.lanes.script.missed, 0);
});

test("reconcile: stopped controllers miss events; only the loop recovers (predict)", () => {
  let s = run(init(), { type: "controllers", on: false });
  s = run(s, { type: "deletePod", side: "loop", name: "worker-1" }, { type: "deletePod", side: "loop", name: "worker-2" }, { type: "replicas", value: 4 });
  s = wait(s, 5);
  s = wait(run(s, { type: "controllers", on: true }), 10);
  assert.equal(ready(s, s.lanes.loop), 4);
  assert.equal(active(s.lanes.script).length, 1);
  assert.ok(s.lanes.script.missed >= 2);
  assert.equal(s.found.stopped, true);
  // and it stays wrong: nothing will ever tell it
  s = wait(s, 120);
  assert.equal(active(s.lanes.script).length, 1);
});

test("reconcile: a spec change during a dropped watch never reaches the script", () => {
  let s = run(init(), { type: "watch", on: false }, { type: "replicas", value: 5 });
  s = wait(s, 3);
  s = wait(run(s, { type: "watch", on: true }), 10);
  assert.equal(ready(s, s.lanes.loop), 5);
  assert.equal(active(s.lanes.script).length, 3);
  assert.equal(s.found.watch, true);
});

test("reconcile: scaling down while the watch is down leaves the script over spec", () => {
  let s = wait(run(init(), { type: "replicas", value: 6 }), 10);
  assert.equal(ready(s, s.lanes.script), 6);
  s = run(s, { type: "watch", on: false }, { type: "replicas", value: 2 });
  s = wait(run(wait(s, 2), { type: "watch", on: true }), 10);
  assert.equal(active(s.lanes.loop).length, 2);
  assert.equal(active(s.lanes.script).length, 6);
  assert.equal(s.found.overshoot, true);
  assert.ok(s.lanes.script.extra > 0);
});

test("reconcile: a dead node's pods are replaced only after NotReady plus the toleration", () => {
  let s = run(init(), { type: "node", index: 0 });
  s = wait(s, NOT_READY_AFTER + EVICT_AFTER - 1);
  assert.equal(active(s.lanes.loop).length, 3, "the dead node's pod still counts until it is evicted");
  assert.equal(ready(s, s.lanes.loop), 2);
  s = wait(s, 10);
  assert.equal(ready(s, s.lanes.loop), 3);
  const r = s.lanes.loop.recoveredAfter!;
  assert.ok(r >= NOT_READY_AFTER + EVICT_AFTER && r < NOT_READY_AFTER + EVICT_AFTER + 10);
  assert.equal(s.found.node, true);
  // The evicted pod never reports DELETED, so the script never replaces it while the node is down.
  s = wait(s, 200);
  assert.equal(ready(s, s.lanes.script), 2);
  // When the node returns, the deletion completes, DELETED arrives late, and the script catches up.
  s = wait(run(s, { type: "node", index: 0 }), 10);
  assert.equal(ready(s, s.lanes.script), 3);
});

test("reconcile: scale-down removes pending pods first, then the newest", () => {
  let s = wait(run(init(), { type: "replicas", value: 5 }), 1);
  const order = deletionOrder(s.lanes.loop).map((p) => p.name);
  assert.ok(order.indexOf("worker-1") > 1, "running pods go after the new pending ones");
  s = wait(run(wait(s, 10), { type: "replicas", value: 3 }), 10);
  assert.equal(active(s.lanes.loop).length, 3);
  assert.equal(active(s.lanes.script).length, 3);
});

test("reconcile: the same click hits both sides, and reset restores the start", () => {
  const s = run(init(), { type: "deletePod", side: "script", name: pod(init(), "script", 1) });
  assert.equal(active(s.lanes.script).length, 2);
  assert.equal(active(s.lanes.loop).length, 2);
  assert.deepEqual(step(s, { type: "reset" }), init());
});
