import { test } from "node:test";
import assert from "node:assert/strict";
import { hb, init, inversions, lamportOrder, misleading, step, ties, wall, wallOrder, type Action, type State } from "../src/playgrounds/lamport-clocks/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const A = 0, B = 1, C = 2;

test("lamport: local events tick by one; a receive takes max(local, message) + 1", () => {
  let s = run(init(), { type: "post", node: A }, { type: "post", node: A }, { type: "send", from: A, to: B });
  assert.deepEqual(s.events.map((e) => e.L), [1, 2, 3]);
  s = run(s, { type: "deliver", msg: 0 });
  const recv = s.events[3];
  assert.equal(recv.L, 4, "B was at 0, the message carried 3");
  assert.equal(recv.prevL, 0);
  assert.ok(s.done.includes("jump"), "B's clock jumped from 0 to 4");
});

test("lamport: the predicted case, a reply on a slow server sorts before its question by wall clock", () => {
  const s = run(init(), { type: "post", node: A }, { type: "send", from: A, to: B }, { type: "deliver", msg: 0 }, { type: "post", node: B });
  const [question, , , reply] = s.events;
  assert.ok(hb(question, reply));
  assert.ok(wall(s, reply) < wall(s, question), "B's clock is 80 ms slow");
  assert.ok(inversions(wallOrder(s)).length > 0);
  assert.equal(inversions(lamportOrder(s)).length, 0, "a cause always has the smaller Lamport time");
  assert.ok(s.done.includes("wall-lies"));
});

test("lamport: with B's clock in sync, the same run is ordered correctly by wall clock too", () => {
  const s = run(init(), { type: "skewB", ms: 0 }, { type: "post", node: A }, { type: "send", from: A, to: B }, { type: "deliver", msg: 0 }, { type: "post", node: B });
  assert.equal(inversions(wallOrder(s)).length, 0);
  // Changing the skew afterwards re-stamps the same run: the inversion appears.
  assert.ok(inversions(wallOrder(step(s, { type: "skewB", ms: -150 }))).length > 0);
});

test("lamport: the Lamport order never inverts cause and effect, whatever the run", () => {
  let s = init();
  const script: Action[] = [];
  for (let i = 0; i < 40; i++) {
    const n = (i * 7) % 3 as 0 | 1 | 2;
    script.push(i % 4 === 0 ? { type: "post", node: n } : { type: "send", from: n, to: ((n + 1 + (i % 2)) % 3) as 0 | 1 | 2 });
    if (i % 3 === 2) script.push({ type: "deliver", msg: Math.floor(i / 3) });
  }
  s = run(s, ...script);
  assert.ok(s.events.length > 40);
  assert.equal(inversions(lamportOrder(s)).length, 0);
  for (const a of s.events) for (const b of s.events) if (hb(a, b)) assert.ok(a.L < b.L, "clock condition");
});

test("lamport: equal times on different servers are a tie broken by server id", () => {
  const s = run(init(), { type: "post", node: A }, { type: "post", node: C });
  assert.equal(ties(s).length, 1);
  assert.deepEqual(lamportOrder(s).map((e) => e.node), [A, C]);
  assert.ok(s.done.includes("tie"));
});

test("lamport: a smaller Lamport time does not mean it caused the other", () => {
  let s = run(init(), { type: "post", node: A }, { type: "post", node: A }, { type: "post", node: C });
  const [, a2, c1] = s.events;
  assert.ok(c1.L < a2.L && !hb(c1, a2) && !hb(a2, c1));
  assert.ok(misleading(s).length > 0);
  s = run(s, { type: "select", event: 1 }, { type: "select", event: 2 });
  assert.ok(s.done.includes("not-cause"));
});

test("lamport: duplicate delivery and reset", () => {
  const s = run(init(), { type: "send", from: A, to: C }, { type: "deliver", msg: 0 });
  assert.equal(run(s, { type: "deliver", msg: 0 }), s);
  assert.equal(run(s, { type: "send", from: A, to: A }), s);
  assert.equal(run(s, { type: "reset" }).events.length, 0);
});
