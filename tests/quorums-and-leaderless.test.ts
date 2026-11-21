import { test } from "node:test";
import assert from "node:assert/strict";
import { init, pendingHints, step, type Action, type State } from "../src/playgrounds/quorums-and-leaderless/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const toggle = (id: number): Action => ({ type: "toggle", id });
const W: Action = { type: "write" }, R: Action = { type: "read" };

test("quorums: the predicted case, N=3 W=2 R=2 overlaps even when the read set changed", () => {
  const s = run(init(), toggle(3), W, toggle(3), toggle(1), R);
  assert.deepEqual(s.lastWrite?.to, [1, 2]);
  assert.deepEqual(s.lastRead?.from, [2, 3]);
  assert.equal(s.lastRead?.stale, false);
  assert.equal(s.lastRead?.recs[0].label, "+book");
  assert.ok(s.done.includes("fresh"), "fresh in the worst case while replica 3 was stale");
});

test("quorums: with W=1 R=1 a read can miss the latest write", () => {
  const s = run(init(), { type: "config", w: 1, r: 1 }, toggle(2), toggle(3), W, toggle(2), toggle(3), R);
  assert.equal(s.lastWrite?.ok, true);
  assert.equal(s.lastRead?.stale, true);
  assert.ok(s.done.includes("stale"));
});

test("quorums: a strict quorum refuses the write when too few home replicas are up, but leaves it behind", () => {
  let s = run(init(), toggle(2), toggle(3), W);
  assert.equal(s.lastWrite?.ok, false);
  assert.equal(s.stats.failedWrites, 1);
  s = run(s, toggle(2), toggle(3), { type: "answer", mode: "rotate" }, R);
  // the rotating read hits replicas 1 and 2: replica 1 still holds the failed write
  assert.equal(s.lastRead?.ghost, true);
  assert.ok(s.done.includes("ghost"));
});

test("quorums: too few replicas up makes a strict read unavailable", () => {
  const s = run(init(), toggle(1), toggle(2), R);
  assert.equal(s.lastRead?.ok, false);
  assert.equal(s.stats.unavailableReads, 1);
});

test("quorums: a sloppy quorum accepts the write on spares, then a read of the home replicas misses it", () => {
  let s = run(init(), { type: "sloppy", on: true }, toggle(1), toggle(2), W);
  assert.equal(s.lastWrite?.ok, true);
  assert.deepEqual(s.lastWrite?.to, [3, 4, 5]);
  assert.equal(pendingHints(s), 2);
  s = run(s, toggle(1), toggle(2), R);
  assert.equal(s.lastRead?.stale, true, "R + W > N, yet the read is stale");
  assert.ok(s.done.includes("sloppy"));
  s = run(s, { type: "handoff" }, R);
  assert.equal(pendingHints(s), 0);
  assert.equal(s.lastRead?.stale, false, "hinted handoff repaired it");
});

test("quorums: concurrent writes, last-write-wins drops one silently, siblings keep both", () => {
  const lww = run(init(), { type: "concurrent" }, R);
  assert.equal(lww.lastWrite?.lost, "+lamp", "the phone's clock is behind, so its write loses");
  assert.equal(lww.lastRead?.recs.length, 1);
  assert.ok(lww.done.includes("lost"));
  const sib = run(init(), { type: "resolve", mode: "siblings" }, { type: "concurrent" }, R);
  assert.equal(sib.lastWrite?.lost, undefined);
  assert.deepEqual(sib.lastRead?.recs.map((x) => x.label).sort(), ["+book", "+lamp"]);
});

test("quorums: changing N starts a new cluster and clamps R and W", () => {
  const s = run(init(), W, { type: "config", n: 5 }, { type: "config", r: 9 });
  assert.equal(s.nodes.length, 7);
  assert.equal(s.r, 5);
  assert.equal(s.ackedGen, 0);
  assert.equal(run(s, { type: "reset" }).n, 3);
});
