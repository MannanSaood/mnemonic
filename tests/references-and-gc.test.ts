import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLECT_EVERY, NIGHTS, PDF_MB, PROGRAMS, heapAt, init, nightly, reachable, refcount, stats, step, type Action, type State } from "../src/playgrounds/references-and-gc/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const nameTo = (h: ReturnType<typeof heapAt>, n: string) => h.names.find((x) => x.name === n)?.to;

test("references-and-gc: a mutable default is one list shared by every call", () => {
  const h = heapAt("defaults", false, 3);
  assert.equal(nameTo(h, "a"), nameTo(h, "b"), "a and b are the same object");
  const list = h.objs[nameTo(h, "a")!];
  assert.equal(list.slots.length, 2, "Ben's address was added to Ana's list");
  assert.equal(refcount(h, list.id), 3, "a, b and recipients.__defaults__");
});

test("references-and-gc: the None default gives each call its own list", () => {
  const h = heapAt("defaults", true, 3);
  assert.notEqual(nameTo(h, "a"), nameTo(h, "b"));
  assert.equal(h.objs[nameTo(h, "a")!].slots.length, 1);
  assert.equal(refcount(h, nameTo(h, "b")!), 1);
});

test("references-and-gc: [row] * 3 makes three references to one row", () => {
  const bug = heapAt("rota", false, 2);
  const outer = h(bug, "rota");
  const rows = outer.slots.map((s) => ("ref" in s.v ? s.v.ref : -1));
  assert.equal(new Set(rows).size, 1);
  assert.equal(refcount(bug, rows[0]), 3);
  assert.deepEqual(bug.objs[rows[2]].slots.map((s) => ("text" in s.v ? s.v.text : "")), ["'ana'", "'-'", "'-'"], "Wednesday shows ana too");
  const fixed = heapAt("rota", true, 2);
  const rows2 = h(fixed, "rota").slots.map((s) => ("ref" in s.v ? s.v.ref : -1));
  assert.equal(new Set(rows2).size, 3);
  assert.equal(fixed.objs[rows2[2]].slots[0].v && "text" in fixed.objs[rows2[2]].slots[0].v ? (fixed.objs[rows2[2]].slots[0].v as { text: string }).text : "", "'-'");
});
function h(heap: ReturnType<typeof heapAt>, name: string) { return heap.objs[nameTo(heap, name)!]; }

test("references-and-gc: del removes a name, not the object", () => {
  const before = heapAt("cycle", false, 2);
  assert.equal(refcount(before, nameTo(before, "run")!), 2);
  const after = heapAt("cycle", false, 3);
  assert.equal(refcount(after, nameTo(after, "run")!), 1);
  assert.equal(stats(after).objects, 2);
});

test("references-and-gc: a cycle survives del, and only gc.collect frees it", () => {
  const dead = heapAt("cycle", false, 5);
  const s = stats(dead);
  assert.equal(dead.names.length, 0);
  assert.equal(s.unreachable, 3, "run, its bound method and its PDFs");
  assert.equal(s.stuckMb, PDF_MB);
  assert.equal(reachable(dead).size, 0);
  const collected = heapAt("cycle", false, 6);
  assert.equal(stats(collected).objects, 0);
  assert.equal(stats(collected).byGc, 3);
});

test("references-and-gc: with a WeakMethod, refcounting frees the run on del", () => {
  const h5 = heapAt("cycle", true, 5);
  assert.equal(stats(h5).objects, 0);
  assert.equal(stats(h5).byGc, 0);
  assert.ok(stats(h5).byRefcount >= 3, "temporary bound method, run, PDFs, WeakMethod");
  assert.equal(stats(heapAt("cycle", true, 6)).byGc, 0, "the collector finds nothing");
});

test("references-and-gc: the nightly loop holds memory only for cycles, and forever with the collector off", () => {
  assert.equal(Math.max(...nightly("weak", true)), 0);
  assert.equal(nightly("cycle", false).at(-1), NIGHTS * PDF_MB);
  const on = nightly("cycle", true);
  assert.equal(Math.max(...on), (COLLECT_EVERY - 1) * PDF_MB);
  assert.equal(on.at(-1), 0);
});

test("references-and-gc: stepping, guesses and finished variants", () => {
  let s = run(init(), { type: "guess", value: "both" }, { type: "guess", value: "one" });
  assert.equal(s.guesses.defaults, "both", "the first guess is locked");
  s = run(s, { type: "runTo", pc: 99 });
  assert.equal(s.pc, PROGRAMS.defaults.lines.bug.length);
  assert.deepEqual(s.finished, ["defaults:bug"]);
  s = run(s, { type: "fixed", fixed: true });
  assert.equal(s.pc, 0);
  s = run(s, { type: "next" }, { type: "next" }, { type: "next" }, { type: "next" }, { type: "back" });
  assert.equal(s.pc, 3);
  s = run(s, { type: "loopGc", on: false }, { type: "loop", design: "cycle" }, { type: "loop", design: "cycle" });
  assert.equal(s.loops.length, 1);
  assert.equal(s.loops[0].peak, NIGHTS * PDF_MB);
});
