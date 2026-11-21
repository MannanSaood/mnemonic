import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, BASE_GOROUTINES, LEAKS_TO_OOM, init, leakRate, simulate, step, type Action, type State } from "../src/playgrounds/goroutine-leaks/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const thousand = (s: State) => run(s, { type: "send", n: 1000 });

test("goroutine-leaks: the original handler leaks about two goroutines per request (every loser)", () => {
  const s = thousand(run(init(), { type: "guess", guess: "losers" }));
  assert.equal(ANSWER, "losers");
  assert.ok(s.totals.leaked > 1700 && s.totals.leaked < 2100, `leaked ${s.totals.leaked}`);
  assert.equal(s.pod.leaked, s.totals.leaked);
  assert.ok(s.totals.timeouts > 0, "some requests time out, and then all three park");
  // the guess is locked once traffic has run
  assert.equal(run(s, { type: "guess", guess: "zero" }).guess, "losers");
});

test("goroutine-leaks: a timed-out request leaks all three senders", () => {
  for (let id = 1; id < 2000; id++) {
    const r = simulate(id, { buf: 0, ctx: false });
    if (r.timedOut && r.lanes.every((l) => l.ok)) { assert.equal(r.leaked, 3); return; }
  }
  assert.fail("no timed-out request with three successful backends");
});

test("goroutine-leaks: the leak keeps growing until the pod is OOM-killed", () => {
  let s = init();
  s = thousand(thousand(s));
  assert.equal(s.pod.restarts, 0);
  s = thousand(s);
  assert.equal(s.pod.restarts, 1);
  assert.match(s.event ?? "", /OOMKilled/);
  assert.ok(s.pod.leaked < LEAKS_TO_OOM);
});

test("goroutine-leaks: a buffer of 1 is the fix for one sender, not for three", () => {
  const one = thousand(run(init(), { type: "setBuf", buf: 1 }));
  assert.ok(one.totals.leaked > 500, `buffer 1 still leaks ${one.totals.leaked}`);
  const two = thousand(run(init(), { type: "setBuf", buf: 2 }));
  assert.ok(two.totals.leaked > 0 && two.totals.leaked < 100, "buffer 2 leaks only on timeouts");
  const three = thousand(run(init(), { type: "setBuf", buf: 3 }));
  assert.equal(three.totals.leaked, 0);
  assert.ok(three.totals.wastedMs > 0, "the losers still do all their backend work");
});

test("goroutine-leaks: ctx alone leaves a trickle (answers that arrived as the handler returned); ctx plus a buffer leaves nothing", () => {
  const ctxOnly = thousand(run(init(), { type: "setCtx", ctx: true }));
  assert.ok(ctxOnly.totals.leaked > 0 && ctxOnly.totals.leaked < 60, `ctx only leaked ${ctxOnly.totals.leaked}`);
  assert.equal(ctxOnly.totals.wastedMs, 0, "cancelled calls stop at once");
  for (let id = 1; id <= 1000; id++) {
    const r = simulate(id, { buf: 0, ctx: true });
    for (const l of r.lanes) if (l.fate === "leaked") assert.equal(l.t, r.returnAt, "only ties with the winner leak");
  }
  const both = thousand(run(init(), { type: "setBuf", buf: 3 }, { type: "setCtx", ctx: true }));
  assert.equal(both.totals.leaked, 0);
  assert.equal(both.totals.wastedMs, 0);
});

test("goroutine-leaks: deploying a new version restarts the pod; runs are kept per version", () => {
  let s = thousand(init());
  s = run(s, { type: "setBuf", buf: 3 }, { type: "setCtx", ctx: true });
  assert.equal(s.pod.leaked, 0);
  assert.equal(BASE_GOROUTINES > 0, true);
  s = thousand(s);
  assert.equal(s.runs.length, 2);
  assert.ok(leakRate(s.runs[0].totals) > 1500);
  assert.equal(leakRate(s.runs[1].totals), 0);
  // same request ids always get the same latencies
  assert.deepEqual(simulate(42, { buf: 0, ctx: false }).lanes.map((l) => l.t), simulate(42, { buf: 3, ctx: true }).lanes.map((l) => l.t));
});
