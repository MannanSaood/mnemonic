import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OFF_DISK, fold, flame, init, program, revealed, step, ticks, trueShare, view,
  type Action, type State,
} from "../src/playgrounds/sampling-and-flame-graphs/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const CUR = "main;http.serve;export.Handler;formatRow;currencySymbol";
const SYNC = "main;http.serve;export.Handler;audit.Record;file.Sync";
const share = (rate: number, mode: "cpu" | "wall", path: string, fixes: string[] = []) => {
  const g = flame(fold(ticks(program(fixes), rate, mode)));
  return (g.frames.find((f) => f.path === path)?.total ?? 0) / g.total;
};

test("flame: folding counts identical stacks, and siblings are sorted alphabetically", () => {
  const folded = fold([
    { t: 0, stack: ["main", "b"], on: true }, { t: 1, stack: ["main", "a"], on: true },
    { t: 2, stack: ["main", "b"], on: true }, { t: 3, stack: null, on: false },
  ]);
  assert.deepEqual([...folded.entries()].sort(), [["main;a", 1], ["main;b", 2]]);
  const g = flame(folded);
  const a = g.frames.find((f) => f.path === "main;a")!, b = g.frames.find((f) => f.path === "main;b")!;
  assert.equal(g.total, 3);
  assert.ok(a.x < b.x, "a is drawn left of b although b was sampled first");
  assert.equal(b.total, 2);
});

test("flame: at 99 Hz the on-CPU graph matches the true CPU shares", () => {
  const p = program([]);
  assert.ok(Math.abs(share(99, "cpu", CUR) - trueShare(p, CUR, "cpu")) < 0.05);
  assert.ok(share(99, "cpu", CUR) > 0.6, "currencySymbol is the widest CPU frame");
  assert.ok(Math.abs(share(997, "cpu", CUR) - trueShare(p, CUR, "cpu")) < 0.01, "more samples, less error");
});

test("flame: the on-CPU graph cannot see the fsync wait; the wall-clock graph shows it as the widest", () => {
  assert.equal(share(99, "cpu", SYNC), 0);
  assert.ok(share(99, "wall", SYNC) > 0.6);
  const p = program([]);
  assert.ok(p.cpuMs < p.wallMs / 2, "most of the export is spent off-CPU");
});

test("flame: 100 Hz in lockstep with a 10 ms timer shows only the timer; 99 Hz does not", () => {
  assert.ok(share(100, "cpu", "main;metrics.flush") > 0.95);
  assert.ok(share(99, "cpu", "main;metrics.flush") < 0.25);
});

test("flame: making the CPU hog free saves about a quarter; removing the wait too gets under 500 ms", () => {
  const base = program([]).wallMs;
  const cur = program(["currencySymbol"]).wallMs;
  assert.ok(base > 3000);
  assert.ok(1 - cur / base > 0.2 && 1 - cur / base < 0.35);
  assert.ok(program(["currencySymbol", "file.Sync"]).wallMs < 500);
});

test("flame: in CPU mode, ticks that find the thread waiting record nothing", () => {
  const v = view(run(init(), { type: "takeAll" }));
  assert.ok(v.taken.filter((s) => !s.stack).length > v.taken.length / 2);
});

test("flame: the prediction is revealed by the fix, and every challenge can be completed", () => {
  let s = run(init(), { type: "guess", value: "25" }, { type: "take", n: 1 }, { type: "take", n: 25 });
  assert.equal(view(s).taken.length, 26);
  assert.equal(revealed(s), false);
  s = run(s, { type: "takeAll" }, { type: "select", path: CUR });
  assert.ok(s.done.includes("hot"));
  s = run(s, { type: "rate", value: 100 });
  assert.ok(s.done.includes("lockstep"));
  s = run(s, { type: "rate", value: 99 }, { type: "fix", name: "currencySymbol" });
  assert.equal(revealed(s), true);
  s = run(s, { type: "mode", value: "wall" }, { type: "select", path: `${SYNC};${OFF_DISK}` });
  assert.ok(s.done.includes("hidden"));
  s = run(s, { type: "fix", name: "file.Sync" });
  assert.deepEqual(s.done, ["hot", "lockstep", "hidden", "fast"]);
  assert.equal(s.history.length, 3);
  assert.equal(run(s, { type: "fix", name: "main" }), s, "the root frame cannot be made free");
  assert.equal(run(s, { type: "reset" }).done.length, 0);
});
