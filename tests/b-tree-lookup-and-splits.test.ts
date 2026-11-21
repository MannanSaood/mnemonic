import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avgFill, checkInvariants, init, LEAF_CAP, leafCount, pagesRead, realHeight, search, spread, step, levels,
  type Action, type State,
} from "../src/playgrounds/b-tree-lookup-and-splits/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ins = (n: number): Action => ({ type: "insert", n });

test("b-tree: the first split happens on insert LEAF_CAP + 1 and the root split makes the tree taller", () => {
  let s = run(init(), ins(LEAF_CAP));
  assert.equal(s.trees[0].height, 1);
  assert.equal(s.trees[0].splits, 0);
  s = run(s, ins(1));
  assert.equal(s.trees[0].height, 2, "a leaf root split adds a level");
  assert.equal(s.trees[0].rootSplits, 1);
  assert.equal(leafCount(s.trees[0]), 2);
});

test("b-tree: invariants hold for every key kind and split rule", () => {
  for (const rule of ["half", "rightEdge"] as const)
    for (const kind of ["serial", "v7", "v4"] as const) {
      const s = run(init(), { type: "rule", rule }, { type: "kind", lane: 0, kind }, ins(1500));
      assert.equal(checkInvariants(s.trees[0]), null, `${rule}/${kind}`);
      assert.equal(checkInvariants(s.trees[1]), null, `${rule}/v4 lane`);
      assert.equal(s.trees[0].count, 1500);
    }
});

test("b-tree: the predicted case, random keys write to many more leaf pages per 100 inserts", () => {
  const s = run(init(), ins(100), ins(100), ins(100));
  const [v7, v4] = s.trees;
  assert.ok(spread(v4) >= 3 * spread(v7), `v4 ${spread(v4)} vs v7 ${spread(v7)}`);
  assert.ok(spread(v7) <= 20, "time-ordered keys only touch the right edge");
});

test("b-tree: right-edge splits pack time-ordered leaves, textbook half splits leave them half empty", () => {
  const packed = run(init(), ins(1000));
  assert.ok(avgFill(packed.trees[0]) > 0.85);
  const half = run(init(), { type: "rule", rule: "half" }, ins(1000));
  assert.ok(avgFill(half.trees[0]) <= 0.55);
  assert.ok(leafCount(half.trees[0]) > leafCount(packed.trees[0]) * 1.6);
  assert.ok(half.trees[0].height > packed.trees[0].height, "emptier pages make a taller tree");
  assert.ok(half.done.includes("halfEmpty"));
  // random keys land about 70% full whichever rule is used
  for (const st of [packed, half]) assert.ok(avgFill(st.trees[1]) > 0.62 && avgFill(st.trees[1]) < 0.8);
});

test("b-tree: a lookup reads one page per level; a range scan follows the leaf chain", () => {
  let s = run(init(), ins(1200), { type: "lookup" });
  for (let i = 0; i < 2; i++) {
    const l = s.lookups[i]!;
    assert.equal(l.found, true);
    assert.equal(pagesRead(l), s.trees[i].height);
  }
  assert.ok(s.done.includes("shallow"));
  s = run(s, { type: "lookup", range: true });
  const l = s.lookups[0]!;
  assert.ok(l.leavesWalked >= 4, "40 keys span several leaves");
  assert.equal(l.path.length, s.trees[0].height, "the range scan descends once");
  // a missing key ends on the leaf where it would be
  const miss = search(s.trees[0], -5, false);
  assert.equal(miss.found, false);
  assert.equal(miss.path[miss.path.length - 1], levels(s.trees[0])[s.trees[0].height - 1][0]);
});

test("b-tree: challenges grow and scatter", () => {
  const s = run(init(), ins(300));
  assert.ok(s.done.includes("grow"));
  assert.ok(s.done.includes("scatter"));
});

test("b-tree: real page sizes keep a billion keys within four levels", () => {
  assert.equal(realHeight(1e9, 366), 4);
  assert.equal(realHeight(1e9, 262), 4);
  assert.equal(realHeight(1e6, 366), 3);
});

test("b-tree: changing a lane's key kind rebuilds that lane only, reset clears all", () => {
  let s = run(init(), ins(50), { type: "kind", lane: 1, kind: "serial" });
  assert.equal(s.trees[1].count, 0);
  assert.equal(s.trees[0].count, 50);
  s = run(s, { type: "reset" });
  assert.equal(s.trees[0].count, 0);
});
