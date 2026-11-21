import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeDone, init, simulate, step, type Action, type Config, type State } from "../src/playgrounds/resiliency-patterns/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const cfg = (c: Partial<Config>): Config => ({ timeout: "1s", retries: 3, backoff: "none", breaker: false, outage: 15, ...c });

test("resiliency: a healthy dependency serves everyone in about 100 ms", () => {
  const { summary } = simulate(cfg({ outage: 0 }));
  assert.equal(summary.ok, 6000);
  assert.equal(summary.retries, 0);
  assert.equal(summary.worstLatency, 100);
});

test("resiliency: eager retries turn a 5-second slowdown into an outage that outlasts it", () => {
  const { summary } = simulate(cfg({ outage: 5 }));
  assert.equal(summary.recovery, null);
  assert.ok(summary.attempts > 3 * 6000, "the dependency sees more than 3x the user traffic");
  assert.ok(summary.wasted > 1000, "most of its work is for callers who already gave up");
});

test("resiliency: backoff and jitter alone do not stop the storm when new users keep arriving", () => {
  const exp = simulate(cfg({ backoff: "exp" })).summary;
  const jit = simulate(cfg({ backoff: "jitter" })).summary;
  assert.equal(exp.recovery, null);
  assert.equal(jit.recovery, null);
});

test("resiliency: without a timeout the API's own worker pool fills and turns users away", () => {
  const { summary } = simulate(cfg({ timeout: "none", retries: 0 }));
  assert.ok(summary.rejected > 0);
  assert.ok(summary.peakInFlight >= 395);
  assert.ok(summary.worstLatency > 10_000);
});

test("resiliency: a circuit breaker never trips without a timeout, because nothing ever fails", () => {
  const plain = simulate(cfg({ timeout: "none", retries: 0 })).summary;
  const withBreaker = simulate(cfg({ timeout: "none", retries: 0, breaker: true })).summary;
  assert.equal(withBreaker.degraded, 0);
  assert.equal(withBreaker.rejected, plain.rejected);
});

test("resiliency: timeout, one jittered retry and a breaker degrade gracefully and recover fast", () => {
  const { summary, seconds } = simulate(cfg({ retries: 1, backoff: "jitter", breaker: true }));
  assert.ok(summary.recovery !== null && summary.recovery <= 5);
  assert.ok(summary.degraded > 1000, "users got a fallback during the slowdown");
  assert.ok(summary.failed + summary.rejected < 100);
  assert.ok(seconds.some((s) => s.breaker === "open"));
  assert.equal(seconds[seconds.length - 1].breaker, "closed");
  assert.ok(summary.peakLoad <= 110, "the dependency never sees more than normal traffic");
});

test("resiliency: a retry budget caps the amplification", () => {
  const eager = simulate(cfg({})).summary;
  const budget = simulate(cfg({ retries: "budget", backoff: "jitter" })).summary;
  assert.ok(budget.retries < 0.15 * 6000);
  assert.ok(budget.attempts < eager.attempts / 2);
});

test("resiliency: runs are kept for comparison, newest first, at most five", () => {
  let s = init();
  for (let i = 0; i < 6; i++) s = run(s, { type: "run" });
  assert.equal(s.runs.length, 5);
  assert.equal(s.runs[0].id, 6);
  assert.equal(s.shown, 6);
});

test("resiliency: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "run" },
    { type: "set", patch: { timeout: "none", retries: 0 } }, { type: "run" },
    { type: "preset", id: "kit" }, { type: "set", patch: { timeout: "300ms" } }, { type: "run" });
  assert.ok(challengeDone(s, "storm"));
  assert.ok(challengeDone(s, "pool"));
  assert.ok(challengeDone(s, "recover"));
  assert.ok(challengeDone(s, "degrade"));
});

test("resiliency: a preset keeps the chosen outage length", () => {
  const s = run(init(), { type: "set", patch: { outage: 30 } }, { type: "preset", id: "kit" });
  assert.equal(s.config.outage, 30);
  assert.equal(s.config.breaker, true);
});
