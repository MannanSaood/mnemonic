import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, PROGRAM, check, evictSkipping, init, runUnchecked, stats, step, type Action, type State } from "../src/playgrounds/borrowing/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const diags = (s: State) => check(PROGRAM[s.program], s.lanes);

test("borrowing: grow is rejected because oldest is used after the push (E0502), as the prediction says", () => {
  const s = init();
  assert.equal(ANSWER, "no");
  const d = diags(s);
  assert.deepEqual(d.map((x) => [x.code, x.row]), [["E0502", 4], ["E0502", 5]]);
  assert.match(d[0].message, /cannot borrow `conns` as mutable because it is also borrowed as immutable/);
  assert.equal(d[0].notes.at(-1)?.row, 7, "the later use is line 7");
});

test("borrowing: deleting the last use ends the borrow early and the program compiles (NLL)", () => {
  const s = run(init(), { type: "guess", guess: "no" }, { type: "toggleUse", lane: "A", row: 7 });
  assert.equal(diags(s).length, 0);
  assert.ok(s.done.includes("nll"));
  assert.equal(s.guess, "no");
  // the guess is locked once the reader has acted
  assert.equal(run(s, { type: "guess", guess: "yes" }).guess, "no");
});

test("borrowing: two mutable borrows alive together are E0499", () => {
  const s = run(init(), { type: "flip", lane: "A" });
  assert.ok(diags(s).some((d) => d.code === "E0499" && d.row === 5));
  assert.ok(s.done.includes("e0499"));
});

test("borrowing: a borrow alive across the final move is E0505", () => {
  const s = run(init(), { type: "toggleUse", lane: "A", row: 7 }, { type: "addLane", row: 7, kind: "shared" });
  assert.equal(diags(s).length, 0, "a borrow created and last used on line 7 ends before the move");
  // a borrow cannot be used after line 8, the last line, so E0505 needs a use past the move: none exist here
  assert.equal(check(PROGRAM.grow, [{ id: "X", name: "x", kind: "shared", start: 2, uses: [9] }]).some((d) => d.code === "E0505"), true);
});

test("borrowing: without the checker, the rejected grow reads freed memory after the reallocating push", () => {
  const s = run(init(), { type: "unchecked", on: true });
  const f = runUnchecked(PROGRAM.grow, s.lanes);
  assert.ok(f.some((x) => x.kind === "dangling" && x.row === 7));
  assert.ok(s.done.includes("dangle"));
  // with the use on line 7 removed, nothing dangles
  const t = run(s, { type: "toggleUse", lane: "A", row: 7 }, { type: "flip", lane: "B" }, { type: "flip", lane: "B" });
  assert.ok(!runUnchecked(PROGRAM.grow, t.lanes).some((x) => x.kind === "dangling"));
});

test("borrowing: removing while iterating is E0502 in Rust and skips stale connections elsewhere", () => {
  let s = run(init(), { type: "program", program: "evict" });
  assert.deepEqual(diags(s).map((d) => [d.code, d.row]), [["E0502", 4]]);
  // the iterator's borrow is fixed by the loop
  assert.equal(run(s, { type: "toggleUse", lane: "A", row: 6 }), s);
  assert.equal(run(s, { type: "removeLane", lane: "A" }), s);
  s = run(s, { type: "unchecked", on: true });
  assert.ok(s.done.includes("skip"));
  assert.deepEqual(evictSkipping([false, true, true, false, true, true]).staleKept, [3, 6]);
  // all stale: every other one survives, as in the failover
  assert.equal(evictSkipping(Array(32).fill(true)).kept.length, 16);
});

test("borrowing: retain compiles, and a borrow held across it does not", () => {
  let s = run(init(), { type: "program", program: "retain" });
  assert.equal(diags(s).length, 0);
  assert.ok(s.done.includes("retain"));
  s = run(s, { type: "addLane", row: 2, kind: "shared" }, { type: "toggleUse", lane: "N1", row: 5 });
  assert.deepEqual(diags(s).map((d) => [d.code, d.row]), [["E0502", 3]]);
  const m = stats(s);
  assert.ok(m.tried >= 3);
  assert.ok(m.rejected >= 1);
});
