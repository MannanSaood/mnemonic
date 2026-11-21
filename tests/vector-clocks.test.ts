import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, init, reconcile, step, type Action, type State } from "../src/playgrounds/vector-clocks/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const A = 0, B = 1, C = 2;

test("vector clocks: compare follows the textbook definition", () => {
  assert.equal(compare([1, 0, 0], [2, 1, 0]), "before");
  assert.equal(compare([2, 1, 0], [1, 2, 0]), "concurrent");
  assert.equal(compare([2, 2, 1], [2, 1, 0]), "after");
  assert.equal(compare([1, 1, 1], [1, 1, 1]), "equal");
});

test("vector clocks: send and receive merge clocks; Lamport takes max + 1", () => {
  const s = run(init(), { type: "write", node: A }, { type: "send", from: A, to: B }, { type: "deliver", msg: 0 });
  const recv = s.events[2];
  assert.deepEqual(recv.vc, [2, 1, 0]);
  assert.equal(recv.lamport, 3);
  assert.equal(compare(s.events[0].vc, recv.vc), "before");
  assert.deepEqual(s.nodes[B].versions[0].items, ["book"]);
  assert.equal(recv.outcome, "replaced");
});

test("vector clocks: the predicted case, concurrent cart writes become siblings", () => {
  const s = run(init(),
    { type: "write", node: A }, { type: "send", from: A, to: B },
    { type: "write", node: B }, { type: "deliver", msg: 0 });
  assert.equal(s.last?.outcome, "conflict");
  assert.equal(s.nodes[B].versions.length, 2);
  assert.deepEqual(s.nodes[B].versions.map((v) => v.items[0]).sort(), ["book", "lamp"]);
  assert.deepEqual(s.last?.lwwDrops, ["lamp"], "LWW by Lamport time keeps A's send (L2) over B's write (L1) and drops lamp");
  assert.ok(s.done.includes("conflict"));
});

test("vector clocks: Lamport order exists between concurrent events, vectors expose it", () => {
  let s = run(init(), { type: "write", node: A }, { type: "write", node: A }, { type: "write", node: C });
  s = run(s, { type: "select", event: 1 }, { type: "select", event: 2 });
  const [a2, c1] = [s.events[1], s.events[2]];
  assert.ok(c1.lamport < a2.lamport);
  assert.equal(compare(a2.vc, c1.vc), "concurrent");
  assert.ok(s.done.includes("lamport-lies"));
});

test("vector clocks: causality through a third node is tracked", () => {
  const s = run(init(),
    { type: "write", node: A }, { type: "send", from: A, to: B }, { type: "deliver", msg: 0 },
    { type: "send", from: B, to: C }, { type: "deliver", msg: 1 },
    { type: "select", event: 0 }, { type: "select", event: 4 });
  assert.equal(compare(s.events[0].vc, s.events[4].vc), "before", "A1 happened before C's receive, through B");
  assert.ok(s.done.includes("causal"));
  assert.deepEqual(s.nodes[C].versions[0].items, ["book"]);
});

test("vector clocks: a merge dominates both siblings and replaces them elsewhere", () => {
  let s = run(init(),
    { type: "write", node: A }, { type: "send", from: A, to: B },
    { type: "write", node: B }, { type: "send", from: B, to: C }, { type: "deliver", msg: 0 });
  assert.equal(run(s, { type: "write", node: B }), s, "no blind write over siblings");
  s = run(s, { type: "merge", node: B });
  assert.equal(s.nodes[B].versions.length, 1);
  assert.deepEqual(s.nodes[B].versions[0].vv, [1, 2, 0]);
  s = run(s, { type: "send", from: B, to: C }, { type: "deliver", msg: 1 }, { type: "deliver", msg: 2 });
  assert.equal(s.events[s.events.length - 1].outcome, "replaced");
  assert.deepEqual(s.nodes[C].versions[0].items.sort(), ["book", "lamp"]);
  assert.ok(s.done.includes("resolved"));
});

test("vector clocks: an old version arriving late is ignored, a duplicate is a no-op", () => {
  assert.equal(reconcile([{ items: ["a"], vv: [1, 0, 0] }, { items: ["a", "b"], vv: [1, 1, 0] }]).length, 1);
  let s = run(init(), { type: "write", node: A }, { type: "send", from: A, to: B }, { type: "write", node: A }, { type: "send", from: A, to: B });
  s = run(s, { type: "deliver", msg: 1 }, { type: "deliver", msg: 0 });
  assert.equal(s.last?.outcome, "kept");
  assert.deepEqual(s.nodes[B].versions[0].items, ["book", "lamp"]);
  assert.equal(run(s, { type: "deliver", msg: 0 }), s);
  assert.equal(run(s, { type: "reset" }).events.length, 0);
});
