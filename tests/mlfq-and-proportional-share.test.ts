import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW, allRuns, init, shareError, simulate, step, type Action, type Config, type Job, type Kind, type State } from "../src/playgrounds/mlfq-and-proportional-share/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const jobs = (...kinds: Kind[]): Job[] => kinds.map((kind, i) => ({ id: i + 1, name: `${kind}${i}`, kind, tickets: 100 }));
const base: Config = { levels: 3, slice: 10, boost: 0, accounting: false };
const share = (r: ReturnType<typeof simulate>, id: number) => r.jobs.find((j) => j.id === id)!;

test("mlfq: the CPU-bound job sinks to the bottom and the interactive job stays on top", () => {
  const r = simulate(jobs("cpu", "interactive"), "mlfq", base);
  assert.equal(share(r, 1).finalLevel, 2);
  assert.equal(share(r, 2).finalLevel, 0);
  assert.equal(share(r, 2).avgResponse, 0, "the interactive job runs the moment it wakes");
});

test("mlfq: without accounting, the gamer takes most of the CPU", () => {
  const r = simulate(jobs("cpu", "gamer"), "mlfq", base);
  assert.ok(share(r, 2).share > 0.8, `${share(r, 2).share}`);
  assert.equal(share(r, 2).finalLevel, 0);
});

test("mlfq: accounting (Rule 4) stops the gaming", () => {
  const r = simulate(jobs("cpu", "gamer"), "mlfq", { ...base, accounting: true });
  assert.ok(share(r, 2).share < 0.5);
  assert.ok(share(r, 2).finalLevel > 0);
});

test("mlfq: two gamers starve the batch job without a boost; a boost (Rule 5) lets it run", () => {
  const starve = simulate(jobs("cpu", "gamer", "gamer"), "mlfq", base);
  assert.ok(share(starve, 1).worstWait > 300, `${share(starve, 1).worstWait}`);
  const boosted = simulate(jobs("cpu", "gamer", "gamer"), "mlfq", { ...base, boost: 50 });
  assert.ok(share(boosted, 1).worstWait <= 60);
  assert.ok(share(boosted, 1).share > 0.1);
  assert.ok(boosted.boosts.length >= 7);
});

test("stride: CPU-hungry jobs get their ticket share almost exactly", () => {
  const t: Job[] = [
    { id: 1, name: "a", kind: "cpu", tickets: 200 },
    { id: 2, name: "b", kind: "cpu", tickets: 100 },
    { id: 3, name: "c", kind: "cpu", tickets: 50 },
  ];
  const r = simulate(t, "stride", base);
  assert.ok(shareError(r, t) < 0.01);
  assert.ok(Math.abs(share(r, 1).share - 4 / 7) < 0.01);
});

test("lottery: right on average, noisy over a short window, and repeatable for a seed", () => {
  const two = jobs("cpu", "cpu");
  const a = simulate(two, "lottery", base, 7), b = simulate(two, "lottery", base, 7);
  assert.deepEqual(a.jobs.map((j) => j.share), b.jobs.map((j) => j.share));
  let worstShort = 0, worstLong = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = simulate(two, "lottery", base, seed);
    worstShort = Math.max(worstShort, shareError(r, two, true));
    worstLong = Math.max(worstLong, shareError(r, two));
  }
  assert.ok(worstShort > worstLong, `${worstShort} vs ${worstLong}`);
  assert.ok(worstLong < 0.1);
});

test("proportional share: the gamer cannot take more than its tickets' worth", () => {
  for (const p of ["lottery", "stride"] as const) {
    const r = simulate(jobs("cpu", "gamer"), p, base, 3);
    assert.ok(share(r, 2).share < 0.55, `${p} ${share(r, 2).share}`);
  }
});

test("stride: a job waking from I/O does not replay the time it slept", () => {
  const r = simulate(jobs("cpu", "interactive"), "stride", base);
  assert.ok(share(r, 1).worstWait <= 2);
});

test("all time is accounted for on every scheduler", () => {
  const js = jobs("cpu", "interactive", "gamer");
  for (const r of allRuns({ jobs: js, cfg: { ...base, boost: 100, accounting: true }, seed: 1 })) {
    const ran = r.jobs.reduce((a, j) => a + j.share * WINDOW, 0);
    assert.equal(Math.round(ran) + r.idle, WINDOW, r.policy);
  }
});

test("mlfq state: the prediction locks once the reader has seen the gaming, and controls are clamped", () => {
  let s = run(init(), { type: "guess", guess: "half" }, { type: "add", kind: "gamer" }, { type: "run" });
  assert.ok(s.sawGaming);
  assert.equal(run(s, { type: "guess", guess: "most" }).guess, "half");
  s = run(s, { type: "slice", value: 7 }, { type: "levels", value: 9 }, { type: "boost", value: 50 });
  assert.equal(s.cfg.slice, 10);
  assert.equal(s.cfg.levels, 3);
  assert.equal(s.cfg.boost, 50);
  for (let i = 0; i < 5; i++) s = step(s, { type: "add", kind: "cpu" });
  assert.equal(s.jobs.length, 5);
  const seed = s.seed;
  assert.notEqual(step(s, { type: "reroll" }).seed, seed);
  assert.equal(run(s, { type: "reset" }).jobs.length, 2);
});
