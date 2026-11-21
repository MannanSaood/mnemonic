import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyse, bucketPercentile, callSample, fanout, fleet, init, percentile, step, summarise,
  type Action, type State,
} from "../src/playgrounds/latency-and-percentiles/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const P = { spikeRate: 0.01, spikeMs: 200, seed: 1 };

test("latency: nearest-rank percentiles", () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 99), 99);
  assert.equal(percentile(xs, 100), 100);
});

test("latency: 99 calls at 10 ms and one at 5 s: the mean describes nobody", () => {
  const s = summarise([...Array(99).fill(10), 5000]);
  assert.equal(s.p50, 10);
  assert.ok(Math.abs(s.mean - 59.9) < 1e-9);
  assert.equal(s.max, 5000);
});

test("latency: 1% stalls barely move the median, but set the p99", () => {
  const c = summarise(callSample(P));
  assert.ok(c.p50 > 9 && c.p50 < 11);
  assert.ok(c.mean < 15, "the mean looks healthy");
  assert.ok(c.p99 > 100, "the p99 is in the stall");
});

test("latency: bigger stalls double the mean while the median stays put", () => {
  const small = summarise(callSample(P)), big = summarise(callSample({ ...P, spikeMs: 5000 }));
  assert.equal(small.p50, big.p50);
  assert.ok(big.mean > 2 * big.p50);
});

test("latency: fan-out to 40 makes about a third of pages slow, as 1 - 0.99^40 predicts", () => {
  const hedgeAt = summarise(callSample(P)).p95;
  const one = fanout(P, 1, false, hedgeAt), forty = fanout(P, 40, false, hedgeAt);
  assert.ok(one.page.slow < 0.02);
  assert.ok(Math.abs(forty.formula - 0.331) < 0.001);
  assert.ok(Math.abs(forty.page.slow - forty.formula) < 0.03);
  assert.ok(forty.page.p99 > 100);
});

test("latency: past about 69 calls, more than half of pages are slow and the page median is a stall", () => {
  const hedgeAt = summarise(callSample(P)).p95;
  const f = fanout(P, 100, false, hedgeAt);
  assert.ok(f.page.slow > 0.5);
  assert.ok(f.page.p50 > 100);
});

test("latency: hedging at p95 costs about 5% more calls and removes the page tail", () => {
  const hedgeAt = summarise(callSample(P)).p95;
  const f = fanout(P, 40, true, hedgeAt);
  assert.ok(f.extraLoad > 0.03 && f.extraLoad < 0.07);
  assert.ok(f.page.p99 < 50);
  assert.ok(f.page.slow < 0.01);
});

test("latency: averaging p99s is wrong in both directions; summed buckets are right within a bucket", () => {
  const low = fleet(1, 0.05), high = fleet(1, 0.5);
  assert.ok(low.tooHigh && low.error > 5, "a degraded server with little traffic drags the average up");
  assert.ok(!high.tooHigh && high.error > 3, "a degraded server with lots of traffic is diluted by the average");
  for (const f of [low, high]) {
    assert.ok(f.mergedP99 >= f.trueP99 && f.mergedP99 <= f.trueP99 * 1.26);
  }
  assert.equal(bucketPercentile(low.merged, 99), low.mergedP99);
});

test("latency: the prediction is revealed at fan-out 40 and the challenges can all be completed", () => {
  let s = run(init(), { type: "guess", value: "33" });
  assert.equal(s.sawForty, false);
  s = run(s, { type: "fanout", value: 40 });
  assert.equal(s.sawForty, true);
  s = run(s, { type: "fanout", value: 80 }, { type: "fanout", value: 40 }, { type: "hedge", on: true },
    { type: "spikeMs", value: 5000 }, { type: "share", value: 0.05 }, { type: "share", value: 0.5 });
  assert.deepEqual(s.done, ["half", "mean", "hedge", "avg"]);
  assert.equal(run(s, { type: "reset" }).done.length, 0);
});

test("latency: the analysis is deterministic for a seed and changes on resample", () => {
  const a = analyse(init()), b = analyse(init());
  assert.equal(a.call.p99, b.call.p99);
  const c = analyse(run(init(), { type: "resample" }));
  assert.notEqual(a.call.max, c.call.max);
});
