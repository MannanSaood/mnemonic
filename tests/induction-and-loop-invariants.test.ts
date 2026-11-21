import { test as t } from "node:test";
import assert from "node:assert/strict";
import {
  CAUGHT_UP, CURSORS, FIXED, LOG, N, SHIPPED, duplicatesPerHour, holds, init, measure, proof, run, step, sweep, truth,
  type Action, type State,
} from "../src/playgrounds/induction-and-loop-invariants/model.ts";

const play = (s: State, ...actions: Action[]) => actions.reduce(step, s);

t("invariants: truth is the lower bound, n when caught up", () => {
  assert.equal(truth(100), 0);
  assert.equal(truth(101), 0);
  assert.equal(truth(106), 2);
  assert.equal(truth(131), N - 1);
  assert.equal(truth(CAUGHT_UP), N);
});

t("invariants: the shipped search is right for every cursor except the caught-up one", () => {
  const sw = sweep(SHIPPED);
  assert.equal(sw.wrong, 1);
  assert.equal(sw.ok, CURSORS.length - 1);
  const c = run(SHIPPED, CAUGHT_UP);
  assert.equal(c.outcome, "wrong");
  assert.equal(c.result, N - 1, "returns the last event instead of n");
  assert.equal(duplicatesPerHour(SHIPPED), 3600);
});

t("invariants: the split fails in the base case, and every step still preserves it", () => {
  const c = run(SHIPPED, CAUGHT_UP);
  const p = proof("split", c, CAUGHT_UP);
  assert.equal(p.base, false);
  assert.equal(p.firstBreak, 0);
  assert.equal(p.step, true, "the iterations are correct; only the start is wrong");
  // On a cursor the shipped code gets right, the invariant holds all the way.
  const ok = proof("split", run(SHIPPED, 113), 113);
  assert.deepEqual([ok.base, ok.step, ok.exit], [true, true, "proves"]);
});

t("invariants: one changed line (hi = n) fixes every cursor and the proof goes through", () => {
  const sw = sweep(FIXED);
  assert.equal(sw.ok, CURSORS.length);
  for (const c of CURSORS) {
    const tr = run(FIXED, c);
    const p = proof("split", tr, c);
    assert.ok(p.base && p.step && p.exit === "proves", `since ${c}`);
    // The measure falls every iteration: termination.
    for (let i = 1; i < tr.frames.length; i++) assert.ok(measure(tr.frames[i]) < measure(tr.frames[i - 1]));
    assert.ok(tr.frames.length - 1 <= Math.ceil(Math.log2(N + 1)), "about log2(n) iterations");
  }
  assert.equal(duplicatesPerHour(FIXED), 0);
});

t("invariants: lo = mid or lo <= hi make the loop hang; lo <= hi with hi = n reads past the end", () => {
  assert.ok(sweep({ ...FIXED, left: "mid" }).hang > 0);
  assert.ok(sweep({ ...SHIPPED, cond: "le" }).hang > 0);
  const crash = run({ ...FIXED, cond: "le" }, CAUGHT_UP);
  assert.equal(crash.outcome, "crash");
  assert.equal(crash.crashMid, N);
});

t("invariants: the weak and the wrong invariants", () => {
  // bounds holds everywhere in the fixed code but proves nothing.
  for (const c of CURSORS) {
    const tr = run(FIXED, c);
    assert.ok(tr.frames.every((f) => holds("bounds", f, c)));
    assert.equal(proof("bounds", tr, c).exit, "silent");
  }
  // "the event at lo is < since" fails at the start for the first cursor, even in correct code.
  assert.equal(proof("loBelow", run(FIXED, 100), 100).base, false);
  assert.ok(LOG[0] >= 100);
});

t("invariants: the guided path plays out and the challenges tick", () => {
  let s = play(init(), { type: "predict", value: "base" }, { type: "since", since: CAUGHT_UP });
  assert.equal(s.sawCaughtUp, false, "not revealed before the reader runs it");
  s = play(s, { type: "step" }, { type: "step" }, { type: "end" });
  assert.ok(s.sawCaughtUp);
  assert.ok(s.done.findBug);
  s = play(s, { type: "toggle", line: "init" });
  assert.ok(s.done.fix);
  assert.equal(s.pos, 0);
  s = play(s, { type: "inv", inv: "bounds" });
  assert.ok(s.done.weak);
  s = play(s, { type: "toggle", line: "cond" }, { type: "end" });
  assert.ok(s.done.crash);
  s = play(s, { type: "toggle", line: "init" }, { type: "since", since: 113 }, { type: "end" });
  assert.ok(s.done.hang);
  assert.equal(play(s, { type: "predict", value: "step" }).prediction, "base");
  assert.deepEqual(play(s, { type: "reset" }), init());
});
