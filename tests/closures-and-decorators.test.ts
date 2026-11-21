import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_NAME, BASE_SIG, GOALS, RECOMMENDED, START, START_WRAPS, allGoalsMet, importOrder, init, meta, simulate, step, totals,
  type Action, type DecId, type State,
} from "../src/playgrounds/closures-and-decorators/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ALL = { timed: true, retry: true };

test("closures-and-decorators: the starting stack names every sample 'wrapper' and times the cache hit", () => {
  const r = simulate(START, START_WRAPS);
  const samples = r.calls.flatMap((c) => c.samples);
  assert.ok(samples.length > 0);
  assert.ok(samples.every((s) => s.name === "wrapper"), "retry has no @wraps, and timed reports retry's wrapper");
  assert.equal(r.calls[1].hit, true);
  assert.equal(r.calls[1].samples.length, 1, "the hit is recorded as a 0 ms sample");
  assert.equal(r.calls[1].samples[0].ms, 0);
  assert.equal(r.meta.cacheInfo, false);
  assert.equal(r.meta.signature, "(*args, **kwargs)");
  assert.equal(r.meta.name, "wrapper", "timed uses @wraps, but it copies the name of retry's wrapper");
});

test("closures-and-decorators: retry inside timed folds attempts and backoff into one sample", () => {
  const r = simulate(["timed", "retry"], ALL);
  assert.deepEqual(r.calls.map((c) => c.samples.length), [1, 1, 1]);
  assert.equal(r.calls[0].samples[0].ms, 30 + 200 + 80);
  assert.equal(r.calls[2].samples[0].ms, 30 + 200 + 30 + 400 + 30);
  assert.equal(r.calls[2].ok, false);
});

test("closures-and-decorators: timed inside retry records one sample per attempt and hides the backoff", () => {
  const r = simulate(["retry", "timed"], ALL);
  assert.deepEqual(r.calls.map((c) => c.samples.length), [2, 1, 3]);
  assert.ok(r.calls[2].samples.every((s) => s.ms === 30));
});

test("closures-and-decorators: a cache under retry still needs the network for the failed id; exceptions are not cached", () => {
  const r = simulate(RECOMMENDED, ALL);
  assert.equal(r.calls[1].http, 0);
  assert.equal(r.calls[2].http, 3);
  assert.equal(totals(r).http, 5);
});

test("closures-and-decorators: the recommended stack meets every goal, and it is the only one", () => {
  assert.ok(allGoalsMet(simulate(RECOMMENDED, ALL)));
  const perms = (xs: DecId[]): DecId[][] => xs.length <= 1 ? [xs] : xs.flatMap((x) => perms(xs.filter((y) => y !== x)).map((p) => [x, ...p]));
  const winners: string[] = [];
  for (const p of perms(["cache", "timed", "retry"])) for (const t of [true, false]) for (const rr of [true, false]) {
    if (allGoalsMet(simulate(p, { timed: t, retry: rr }))) winners.push(`${p.join(",")}:${t}:${rr}`);
  }
  assert.deepEqual(winners, ["cache,timed,retry:true:true"]);
  assert.equal(GOALS.length, 4);
});

test("closures-and-decorators: lru_cache copies whatever name the layer below claims", () => {
  const m = meta(["cache", "timed"], { timed: false, retry: true });
  assert.equal(m.name, "wrapper");
  assert.equal(m.signature, "(*args, **kwargs)");
  assert.equal(m.wrappedDepth, 1);
  assert.equal(meta(["cache", "timed", "retry"], ALL).signature, BASE_SIG);
});

test("closures-and-decorators: decorators apply bottom-up", () => {
  const order = importOrder(RECOMMENDED, ALL);
  assert.match(order[0], /^retry\(times=3\)\(fetch_invoice\)/);
  assert.match(order[2], /^lru_cache/);
});

test("closures-and-decorators: the guided path from the start to the recommended stack", () => {
  let s = run(init(), { type: "guess", guess: "wrapper" }, { type: "send" });
  assert.equal(s.guess, "wrapper");
  assert.equal(run(s, { type: "guess", guess: "retry" }).guess, "wrapper", "the guess is locked");
  s = run(s, { type: "wraps", dec: "retry" });
  assert.ok(GOALS[1].met(s.run!), "with @wraps on retry the samples say fetch_invoice");
  s = run(s, { type: "move", dec: "cache", dir: -1 }, { type: "move", dec: "cache", dir: -1 });
  assert.deepEqual(s.stack, RECOMMENDED);
  assert.ok(allGoalsMet(s.run!));
  assert.equal(s.changes, 3);
  assert.equal(totals(s.baseline!).wrapperSamples, 3);
});

test("closures-and-decorators: removing and adding a decorator puts it outermost", () => {
  let s = run(init(), { type: "send" }, { type: "remove", dec: "timed" });
  assert.deepEqual(s.stack, ["retry", "cache"]);
  assert.equal(totals(s.run!).samples, 0);
  s = run(s, { type: "add", dec: "timed" });
  assert.deepEqual(s.stack, ["timed", "retry", "cache"]);
});
