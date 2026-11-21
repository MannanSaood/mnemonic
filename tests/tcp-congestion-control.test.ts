import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IW, RTO_ROUNDS, bufferPackets, capacity, goals, init, maxQueueMs, shareA, step, utilization,
  type Action, type Goals, type State,
} from "../src/playgrounds/tcp-congestion-control/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ticks = (s: State, n: number) => step(s, { type: "tick", n });
const none: Goals = { found: false, full: false, fair: false, timeout: false };

test("cc: the link numbers are what the view says (12 Mbit/s at 40 ms is 40 packets)", () => {
  assert.equal(capacity(12), 40);
  assert.equal(capacity(6), 20);
  assert.equal(bufferPackets(12, "quarter"), 10);
});

test("cc: slow start doubles the window every RTT and reaches the link in 2 RTTs (the predict answer)", () => {
  const s = ticks(init(), 3);
  assert.deepEqual(s.history.map((h) => h.cwnd.A), [IW, IW * 2, IW * 4]);
  assert.equal(s.history[2].cwnd.A, capacity(12));
  assert.equal(s.flows.A.phase, "slow start");
});

test("cc: the first overflow halves the window that fitted, then growth is one packet per RTT", () => {
  let s = init();
  while (s.flows.A.fastRecoveries === 0) s = ticks(s, 1);
  const limit = capacity(12) + bufferPackets(12, "one");
  assert.equal(s.flows.A.ssthresh, limit / 2);
  assert.equal(s.flows.A.cwnd, limit / 2);
  assert.equal(s.flows.A.phase, "avoidance");
  const c = s.flows.A.cwnd;
  s = ticks(s, 5);
  assert.equal(s.flows.A.cwnd, c + 5);
  assert.equal(goals(s, none).found, true);
});

test("cc: the sawtooth peaks at link + queue and repeats", () => {
  const s = ticks(init(), 200);
  const limit = capacity(12) + bufferPackets(12, "one");
  const peaks = s.history.filter((h) => h.marks.some((m) => m.kind === "fast")).map((h) => h.cwnd.A);
  assert.ok(peaks.length >= 4);
  for (const p of peaks.slice(1)) assert.equal(p, limit + 1);
});

test("cc: the 200 KB response takes several RTTs from a cold start", () => {
  const s = ticks(init(), 10);
  assert.equal(s.responseAt, 5);
});

test("cc: buffer size trades utilization against queueing delay; 1 BDP keeps Reno's link full", () => {
  const at = (b: "quarter" | "one" | "two") => ticks(run(init(), { type: "buffer", buffer: b }), 200);
  const q = at("quarter"), o = at("one"), t = at("two");
  assert.ok(utilization(q) < 0.95, "a small buffer leaves the link idle after each halving");
  assert.ok(utilization(o) > 0.99);
  assert.ok(maxQueueMs(t) > maxQueueMs(o) && maxQueueMs(o) > maxQueueMs(q));
  assert.equal(goals(o, none).full, true);
  assert.equal(goals(q, none).full, false);
});

test("cc: a late second flow converges to about half (the second predict answer)", () => {
  let s = ticks(init(), 40);
  s = step(s, { type: "flowB" });
  s = ticks(s, 20);
  assert.ok((shareA(s) ?? 0) > 0.65, "A starts with the bigger share");
  s = ticks(s, 140);
  const a = shareA(s)!;
  assert.ok(Math.abs(a - 0.5) < 0.05, `A has ${a}`);
  assert.equal(goals(s, none).fair, true);
});

test("cc: losing a whole window costs an RTO of silence and a restart from one packet", () => {
  let s = ticks(init(), 30);
  const before = s.flows.A.cwnd;
  s = run(s, { type: "dropWindow" }, { type: "tick" });
  assert.equal(s.flows.A.phase, "timeout");
  assert.equal(s.flows.A.ssthresh, Math.floor(before / 2));
  s = ticks(s, RTO_ROUNDS);
  const silent = s.history.slice(-RTO_ROUNDS).map((h) => h.cwnd.A);
  assert.deepEqual(silent, Array(RTO_ROUNDS).fill(0));
  assert.equal(s.flows.A.cwnd, 1);
  assert.equal(s.flows.A.phase, "slow start");
  assert.equal(goals(s, none).timeout, true);
});

test("cc: a single dropped packet only halves the window", () => {
  let s = ticks(init(), 30);
  const before = s.flows.A.cwnd;
  s = run(s, { type: "dropOne" }, { type: "tick" });
  assert.equal(s.flows.A.cwnd, Math.floor(before / 2));
  assert.equal(s.flows.A.timeouts, 0);
});

test("cc: an unresponsive UDP sender squeezes TCP but keeps sending", () => {
  const alone = ticks(init(), 200);
  const shared = ticks(run(ticks(init(), 40), { type: "udp" }), 160);
  const tcp = (s: State) => s.history.slice(-60).reduce((x, h) => x + h.delivered.A, 0);
  assert.ok(tcp(shared) < tcp(alone) * 0.7);
  assert.ok(shared.history.slice(-60).every((h) => h.udp > 0));
});

test("cc: reset returns to the initial state", () => {
  const s = run(init(), { type: "tick", n: 20 }, { type: "flowB" }, { type: "reset" });
  assert.deepEqual(s, init());
});
