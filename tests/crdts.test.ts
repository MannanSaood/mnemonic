import { test } from "node:test";
import assert from "node:assert/strict";
import { converged, eggs, init, items, laws, merge, resurrected, same, step, type Action, type NodeId, type State } from "../src/playgrounds/crdts/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const A = 0, B = 1, C = 2;
const sync = (from: NodeId, to: NodeId): Action => ({ type: "sync", from, to });

test("crdts: the predicted case, concurrent +1 taps all count; naive max loses one", () => {
  let s = run(init(), { type: "inc", node: A }, { type: "inc", node: A }, { type: "inc", node: B });
  assert.equal(eggs(s.nodes[A]), 3);
  assert.equal(eggs(s.nodes[B]), 2);
  s = run(s, sync(A, B), sync(B, A), sync(A, B), sync(B, A));
  assert.equal(eggs(s.nodes[A]), 4);
  assert.equal(eggs(s.nodes[B]), 4);
  assert.equal(s.nodes[B].naive.eggs, 3, "max of 3 and 2 drops B's tap");
  assert.ok(s.done.includes("concurrent-inc"));
  assert.equal(s.syncs.filter((x) => !x.changed).length, 2, "the second round changes nothing");
});

test("crdts: removing on one phone sticks; the naive union brings the item back", () => {
  let s = run(init(), sync(A, B)); // both start with oat milk and bread
  s = run(s, { type: "remove", node: A, item: "bread" }, sync(B, A));
  assert.deepEqual(items(s.nodes[A]), ["oat milk"]);
  assert.deepEqual(resurrected(s.nodes[A]), ["bread"]);
  assert.ok(s.done.includes("resurrect"));
});

test("crdts: OR-Set, a concurrent add wins over a remove", () => {
  let s = run(init(),
    { type: "remove", node: A, item: "bread" },
    { type: "remove", node: B, item: "bread" }, { type: "add", node: B, item: "bread" });
  s = run(s, sync(B, A));
  assert.ok(items(s.nodes[A]).includes("bread"), "B's new tag was never seen by A's remove");
  assert.ok(s.done.includes("add-wins"));
  // Removed and then re-added on the same replica also works, unlike a two-phase set.
  assert.ok(items(s.nodes[B]).includes("bread"));
});

test("crdts: LWW register keeps one of two concurrent slot picks and drops the other", () => {
  let s = run(init(), { type: "slot", node: A, value: "Sat 18:00" }, { type: "slot", node: B, value: "Sun 10:00" });
  s = run(s, sync(A, B), sync(B, A));
  assert.equal(s.nodes[A].doc.slot.value, "Sun 10:00", "equal Lamport time, B's id is higher");
  assert.equal(s.lost.length, 1);
  assert.equal(s.lost[0].value, "Sat 18:00");
  assert.ok(s.done.includes("lww-lost"));
  // A pick made after seeing the other's is not a loss.
  s = run(s, { type: "slot", node: A, value: "Sat 10:00" }, sync(A, B));
  assert.equal(s.nodes[B].doc.slot.value, "Sat 10:00");
  assert.equal(s.lost.length, 1);
});

test("crdts: two offline decrements of the last egg go negative after merge", () => {
  let s = run(init(), sync(A, B), { type: "dec", node: A }, { type: "dec", node: B });
  assert.equal(eggs(s.nodes[A]), 0);
  assert.equal(run(s, { type: "dec", node: A }), s, "the local check refuses to go below zero");
  s = run(s, sync(A, B));
  assert.equal(eggs(s.nodes[B]), -1);
  assert.ok(s.done.includes("negative"));
});

test("crdts: any order of syncs converges, and the merge laws hold", () => {
  const edits: Action[] = [
    { type: "inc", node: A }, { type: "dec", node: C }, { type: "add", node: B, item: "coffee" },
    { type: "remove", node: C, item: "oat milk" }, { type: "slot", node: C, value: "Sat 18:00" }, { type: "add", node: A, item: "rice" },
  ];
  const orders: Action[][] = [
    [sync(A, B), sync(B, C), sync(C, A), sync(A, B)],
    [sync(C, B), sync(A, B), sync(B, A), sync(B, C), sync(A, B)],
    [{ type: "syncAll" }],
    [sync(B, A), sync(B, A), sync(C, A), sync(A, B), sync(A, C)],
  ];
  const finals = orders.map((o) => run(run(init(), ...edits), ...o));
  for (const f of finals) {
    assert.ok(converged(f));
    assert.deepEqual(laws(f), { commutative: true, associative: true, idempotent: true });
  }
  for (const f of finals) assert.ok(same(f.nodes[0].doc, finals[0].nodes[0].doc), "same result whatever the order");
  assert.deepEqual(items(finals[0].nodes[A]), ["bread", "coffee", "rice"]);
  assert.equal(eggs(finals[0].nodes[A]), 1);
  const mid = run(init(), ...edits);
  assert.deepEqual(laws(mid), { commutative: true, associative: true, idempotent: true }, "laws hold on diverged states too");
  assert.ok(same(merge(mid.nodes[0].doc, mid.nodes[0].doc), mid.nodes[0].doc));
});

test("crdts: no-op edits and reset", () => {
  const s = init();
  assert.equal(step(s, { type: "add", node: A, item: "bread" }), s);
  assert.equal(step(s, { type: "remove", node: A, item: "rice" }), s);
  assert.equal(step(s, { type: "slot", node: A, value: "Sat 10:00" }), s);
  assert.equal(step(s, sync(A, A)), s);
  assert.equal(run(s, { type: "inc", node: A }, { type: "reset" }).nodes[A].edits, 0);
});
