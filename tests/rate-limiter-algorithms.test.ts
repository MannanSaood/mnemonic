import { test } from "node:test";
import assert from "node:assert/strict";
import {
  busiest, histogram, init, pattern, runAll, runLane, step,
  type Action, type Algo, type Config, type Lane, type State,
} from "../src/playgrounds/rate-limiter-algorithms/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const cfg = (c: Partial<Config> = {}): Config => ({ rate: 10, burst: 10, race: false, ...c });
const byAlgo = (lanes: Lane[]) => Object.fromEntries(lanes.map((l) => [l.algo, l])) as Record<Algo, Lane>;

test("rate limiter: under the limit every algorithm admits everything", () => {
  const lanes = runAll(pattern("steady", 10), cfg());
  for (const l of lanes) assert.equal(l.rejected, 0, l.algo);
});

test("rate limiter: a fixed window lets 2r through across a boundary (the predict answer)", () => {
  const by = byAlgo(runAll(pattern("boundary", 10), cfg()));
  assert.equal(by.fixed.admitted, 20);
  assert.equal(by.fixed.peak, 20, "all 20 inside 200 ms");
  assert.equal(by.log.peak, 10, "the sliding log never exceeds r in any second");
  assert.ok(by.counter.peak <= 11, "the sliding counter stays close to r");
});

test("rate limiter: the token bucket admits a burst of b, the leaky bucket delays it instead", () => {
  const by = byAlgo(runAll(pattern("burst", 10), cfg({ burst: 20 })));
  assert.ok(by.token.peak > 20, "burst plus refill reaches the backend at once");
  assert.equal(by.token.maxDelay, 0);
  assert.ok(by.leaky.peak <= 10, "the leaky bucket's output never beats its drain rate");
  assert.ok(by.leaky.maxDelay > 1000, "a deep queue means long waits");
  assert.equal(by.token.admitted, by.leaky.admitted, "same capacity, same admissions; only the timing differs");
});

test("rate limiter: a bucket of 1 turns both buckets into strict spacers", () => {
  const by = byAlgo(runAll(pattern("burst", 10), cfg({ burst: 1 })));
  assert.ok(by.token.peak <= 10 && by.leaky.peak <= 10);
});

test("rate limiter: the sliding counter assumes last second's requests were spread out, so it punishes retry waves", () => {
  const by = byAlgo(runAll(pattern("storm", 10), cfg()));
  assert.ok(by.counter.admitted < by.log.admitted);
});

test("rate limiter: two gateways without an atomic update let the sliding log exceed its limit", () => {
  const plain = runLane("log", pattern("boundary", 10), cfg());
  const raced = runLane("log", pattern("boundary", 10), cfg({ race: true }));
  assert.equal(plain.peak, 10);
  assert.ok(raced.peak > 10, `raced peak ${raced.peak}`);
  assert.ok(raced.decisions.some((d) => d.node === 1));
});

test("rate limiter: busiest counts timestamps in a half-open one-second span", () => {
  assert.deepEqual(busiest([0, 500, 999, 1000]), { n: 3, at: 0 });
  assert.deepEqual(busiest([]), { n: 0, at: 0 });
});

test("rate limiter: clicking a slot adds five requests in that 100 ms slot", () => {
  const s = run(init(), { type: "clear" }, { type: "slot", slot: 9 });
  assert.equal(s.arrivals.length, 5);
  assert.deepEqual(histogram(s.arrivals).slice(8, 11), [0, 5, 0]);
  assert.equal(s.pattern, "custom");
});

test("rate limiter: a named pattern rescales with the limit", () => {
  const s = run(init(), { type: "pattern", pattern: "boundary" }, { type: "rate", rate: 20 });
  assert.equal(s.arrivals.length, 40);
});

test("rate limiter: the prediction is revealed only after the boundary burst is tried, and locks", () => {
  let s = run(init(), { type: "predict", value: "10" }, { type: "predict", value: "20" });
  assert.equal(s.prediction, "10");
  assert.equal(s.sawBoundary, false);
  s = step(s, { type: "pattern", pattern: "boundary" });
  assert.equal(s.sawBoundary, true);
});

test("rate limiter: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "pattern", pattern: "boundary" },             // double
    { type: "burst", burst: 20 },                         // burstOnly: token takes all 20, log refuses 10
    { type: "pattern", pattern: "burst" },                // shaped: leaky queue of 20
    { type: "pattern", pattern: "boundary" }, { type: "race", on: true }); // race
  assert.deepEqual(s.done, { double: true, shaped: true, burstOnly: true, race: true });
});
