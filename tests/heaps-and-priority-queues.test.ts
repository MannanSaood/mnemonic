import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_JOBS, START, benchQueue, benchTopK, before, depth, heapPop, heapPush, init, step, trueMin, violations,
  type Action, type Job, type State,
} from "../src/playgrounds/heaps-and-priority-queues/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const job = (id: number, prio: number): Job => ({ id, name: `job ${id}`, prio });

test("heaps: the starting heap is valid and its root is the most urgent job", () => {
  const s = init();
  assert.equal(s.heap.length, START.length);
  assert.deepEqual(violations(s.heap), []);
  assert.equal(s.heap[0].prio, Math.min(...START));
  assert.equal(s.ops, 0);
});

test("heaps: popping everything returns jobs in priority order, ties oldest first", () => {
  let h: Job[] = [];
  const prios = [5, 3, 9, 3, 1, 7, 5, 2, 8, 3];
  prios.forEach((p, i) => { h = heapPush(h, job(i, p), false).heap; assert.deepEqual(violations(h), []); });
  const out: Job[] = [];
  while (h.length) { const r = heapPop(h, false); out.push(r.job!); h = r.heap; assert.deepEqual(violations(h), []); }
  for (let i = 1; i < out.length; i++) assert.ok(before(out[i - 1], out[i]));
  assert.deepEqual(out.filter((j) => j.prio === 3).map((j) => j.id), [1, 3, 9]);
});

test("heaps: a push or pop moves at most one job per level", () => {
  let h: Job[] = [];
  for (let i = 0; i < 1000; i++) {
    const r = heapPush(h, job(i, 1000 - i), false); // each new job is the most urgent: worst case
    assert.ok(r.moves <= depth(h.length));
    h = r.heap;
  }
  assert.equal(h[0].prio, 1);
  for (let i = 0; i < 50; i++) {
    const r = heapPop(h, false);
    assert.ok(r.moves <= depth(h.length - 1) + 1);
    h = r.heap;
  }
});

test("heaps: pushing an urgent job climbs from a deep leaf to the root, step by step", () => {
  const s = run(init(), { type: "push", prio: 5 });
  assert.equal(s.heap[0].prio, 5);
  assert.equal(s.last?.levels, 3);
  assert.equal(s.last?.moves, 3);
  assert.ok(s.done.climb);
  assert.ok(s.frames.length >= 7, "append, then a compare and a swap per level");
  assert.deepEqual(s.frames[s.frames.length - 1].heap, s.heap);
});

test("heaps: a dispatch takes the root and refills it from the last leaf", () => {
  const s0 = init();
  const s = run(s0, { type: "pop" });
  assert.equal(s.last?.job?.prio, 12);
  assert.equal(s.heap.length, START.length - 1);
  assert.deepEqual(violations(s.heap), []);
  assert.equal(s.last?.wrong, null);
  assert.equal(s.frames[1].heap[0].id, s0.heap[s0.heap.length - 1].id, "the last job moves to the root first");
});

test("heaps: the sorted list holds the same jobs and pays for pushes in shifts", () => {
  let s = init();
  for (let i = 0; i < 20; i++) s = run(s, { type: "push" });
  assert.deepEqual(s.sorted.map((j) => j.id).sort((a, b) => a - b), s.heap.map((j) => j.id).sort((a, b) => a - b));
  for (let i = 1; i < s.sorted.length; i++) assert.ok(before(s.sorted[i], s.sorted[i - 1]), "most urgent last");
  assert.equal(s.sorted[s.sorted.length - 1].id, s.heap[0].id);
  assert.ok(s.done.deep);
  s = run(s, { type: "pop" });
  assert.equal(s.last?.sortedMoves, 0, "popping the end of the sorted list moves nothing");
});

test("heaps: changing a priority without sifting breaks the rule and dispatches the wrong job", () => {
  let s = init();
  const leaf = s.heap.length - 1;
  s = run(s, { type: "corrupt", index: leaf });
  assert.ok(violations(s.heap).length > 0);
  const urgent = trueMin(s.heap)!;
  assert.equal(urgent.prio, 1);
  s = run(s, { type: "pop" });
  assert.notEqual(s.last?.job?.id, urgent.id);
  assert.equal(s.last?.wrong?.id, urgent.id);
  assert.equal(s.wrong, 1);
  assert.ok(s.done.wrong);
});

test("heaps: the same change made with a sift keeps the heap correct", () => {
  let s = init();
  s = run(s, { type: "urgent", index: s.heap.length - 1 });
  assert.deepEqual(violations(s.heap), []);
  assert.equal(s.heap[0].prio, 1);
  s = run(s, { type: "pop" });
  assert.equal(s.last?.wrong, null);
  assert.equal(s.last?.job?.prio, 1);
});

test("heaps: the predict answer, a sorted list makes over 100 times the moves at 10,000 jobs", () => {
  const small = benchQueue(1000);
  const big = benchQueue(10000);
  assert.ok(small.sortedMoves / small.heapMoves > 15 && small.sortedMoves / small.heapMoves < 40);
  assert.ok(big.sortedMoves / big.heapMoves > 100);
  assert.ok(Math.abs(big.sortedMoves - 10000 ** 2 / 4) < 0.05 * 10000 ** 2 / 4, "about n²/4 shifts");
  const s = run(init(), { type: "bench", kind: "queue", n: 10000 });
  assert.ok(s.done.bench);
});

test("heaps: top-k with a size-k heap moves far fewer jobs than a size-k sorted list, and both beat sorting", () => {
  const b = benchTopK(100000, 100);
  assert.ok(b.sortedMoves > 5 * b.heapMoves);
  assert.ok(b.heapCompares < b.sortAllCompares / 10);
});

test("heaps: the queue stops at what the tree can draw, and the prediction locks", () => {
  let s = init();
  for (let i = 0; i < 40; i++) s = run(s, { type: "push" });
  assert.equal(s.heap.length, MAX_JOBS);
  assert.deepEqual(violations(s.heap), []);
  const p = run(init(), { type: "predict", value: "100" }, { type: "predict", value: "1" });
  assert.equal(p.prediction, "100");
});
