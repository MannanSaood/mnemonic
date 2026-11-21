import { test } from "node:test";
import assert from "node:assert/strict";
import { HOURS, evaluate, init, step, traffic, type Action, type Ev, type State } from "../src/playgrounds/slis-and-slos/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ev = (id: number, kind: Ev["kind"], day: number, when: Ev["when"] = "peak"): Ev => ({ id, kind, day, when });

test("slis-and-slos: a month is 72 million requests, so 99.9% allows 72,000 failures, about 43 minutes", () => {
  const r = evaluate([], "availability", 99.9);
  assert.ok(Math.abs(r.valid - 72_000_000) < 1);
  assert.ok(Math.abs(r.budget - 72_000) < 1);
  assert.ok(Math.abs(r.budgetMinutes - 43.2) < 0.01);
  assert.ok(traffic(14) > 155_000 && traffic(3) < 50_000, "peak and night traffic differ about fourfold");
});

test("slis-and-slos: background errors and the release train use about a quarter of the budget", () => {
  const s = init();
  const r = evaluate(s.events, s.sli, s.slo);
  const end = r.remaining[HOURS - 1];
  assert.ok(end > 0.7 && end < 0.8, `left ${end}`);
  assert.equal(r.frozen, 0);
  assert.equal(r.shipped, 9);
});

test("slis-and-slos: a 20-minute bad release at the peak costs about three quarters, at night about a fifth", () => {
  const peak = evaluate([ev(1, "bad", 9, "peak")], "availability", 99.9).costs[0].share;
  const night = evaluate([ev(1, "bad", 9, "quiet")], "availability", 99.9).costs[0].share;
  assert.ok(peak > 0.72 && peak < 0.76, `peak ${peak}`);
  assert.ok(night > 0.18 && night < 0.23, `night ${night}`);
});

test("slis-and-slos: once the budget is gone the policy freezes later releases, which then cost nothing", () => {
  const s = run(init(), { type: "day", day: 5 }, { type: "day", day: 8 });
  const r = evaluate(s.events, s.sli, s.slo);
  assert.ok(r.exhaustedAt !== null && r.exhaustedAt < 8 * 24);
  assert.ok(r.frozen >= 7, `frozen ${r.frozen}`);
  for (const c of r.costs) if (c.frozen) assert.equal(c.bad, 0);
  assert.ok(s.done.freeze);
});

test("slis-and-slos: the mean-latency SLI never sees a slow dependency that the threshold SLI charges for", () => {
  const events = [ev(1, "slow", 12)];
  const mean = evaluate(events, "mean", 99.9);
  const lat = evaluate(events, "latency", 99);
  assert.equal(mean.bad, 0);
  assert.equal(mean.value, 1);
  assert.ok(lat.costs[0].share > 0.2, `latency SLI charges ${lat.costs[0].share}`);
  const avail = evaluate(events, "availability", 99.9);
  assert.equal(avail.costs[0].bad, 0, "no request failed, so availability is blind to it too");
});

test("slis-and-slos: a latency target tighter than everyday performance is spent with no incident at all", () => {
  const r = evaluate([], "latency", 99.9);
  assert.ok(r.exhaustedAt !== null && r.exhaustedAt < 15 * 24);
});

test("slis-and-slos: a zone outage is not a release, so the policy cannot freeze it", () => {
  const r = evaluate([ev(1, "bad", 2), ev(2, "bad", 3), ev(3, "zone", 10)], "availability", 99.9);
  assert.equal(r.costs.find((c) => c.id === 3)!.frozen, false);
  assert.ok(r.costs.find((c) => c.id === 3)!.share > 0.5);
});

test("slis-and-slos: the predict is revealed by a peak bad release, and predictions are fixed once made", () => {
  let s = run(init(), { type: "predict", value: "10" }, { type: "predict", value: "75" });
  assert.equal(s.prediction, "10");
  s = run(s, { type: "day", day: 9 });
  assert.ok(s.events.some((e) => e.kind === "bad" && e.when === "peak"));
});

test("slis-and-slos: the guided challenges can all be completed", () => {
  const s = run(init(),
    { type: "tool", tool: "bad" }, { type: "when", when: "quiet" }, { type: "day", day: 6 },
    { type: "when", when: "peak" }, { type: "day", day: 7 },
    { type: "slo", slo: 99.95 },
    { type: "tool", tool: "slow" }, { type: "day", day: 20 }, { type: "sli", sli: "mean" },
    { type: "sli", sli: "availability" }, { type: "slo", slo: 99.9 },
    { type: "tool", tool: "remove" }, { type: "day", day: 7 }, { type: "sli", sli: "availability" });
  assert.ok(s.done.one, "one");
  assert.ok(s.done.freeze, "freeze");
  assert.ok(s.done.hidden, "hidden");
  assert.ok(s.done.survive, "survive");
});

test("slis-and-slos: remove takes the day's last event off, reset restores the plan", () => {
  let s = run(init(), { type: "tool", tool: "remove" }, { type: "day", day: 2 });
  assert.equal(s.events.length, 8);
  s = run(s, { type: "clear" });
  assert.equal(s.events.length, 0);
  s = run(s, { type: "reset" });
  assert.equal(s.events.length, 9);
});
