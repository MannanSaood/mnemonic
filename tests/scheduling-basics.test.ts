import { test } from "node:test";
import assert from "node:assert/strict";
import { allSchedules, init, preset, schedule, step, verdict, type Action, type Job, type State } from "../src/playgrounds/scheduling-basics/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const three = (run: number): Job[] => [1, 2, 3].map((id) => ({ id, name: `j${id}`, kind: "batch", arrival: 0, run }));

test("sched: FIFO with three equal jobs averages 20 ms turnaround (OSTEP's first example)", () => {
  assert.equal(schedule(three(10), "fifo").avgTurnaround, 20);
});

test("sched: the convoy, FIFO 110 ms against SJF 50 ms", () => {
  const jobs = preset("convoy");
  assert.equal(schedule(jobs, "fifo").avgTurnaround, 110);
  assert.equal(schedule(jobs, "sjf").avgTurnaround, 50);
});

test("sched: late arrivals defeat non-preemptive SJF; STCF preempts and gets 50 ms", () => {
  const jobs = preset("late");
  assert.ok(Math.abs(schedule(jobs, "sjf").avgTurnaround - 310 / 3) < 1e-9);
  assert.equal(schedule(jobs, "stcf").avgTurnaround, 50);
});

test("sched: round robin with 1 ms slices gives response 1 ms on average but stretches turnaround", () => {
  const rr = schedule(three(5), "rr", 1);
  assert.deepEqual(rr.stats.map((s) => s.completion), [13, 14, 15]);
  assert.equal(rr.avgResponse, 1);
  const sjf = schedule(three(5), "sjf");
  assert.equal(sjf.avgResponse, 5);
  assert.ok(rr.avgTurnaround > sjf.avgTurnaround);
});

test("sched: a 1 ms slice with a 1 ms switch wastes the CPU", () => {
  const jobs = preset("mixed");
  const cheap = schedule(jobs, "rr", 10, 0), costly = schedule(jobs, "rr", 1, 1);
  assert.ok(costly.switchMs >= 50);
  assert.ok(costly.makespan > cheap.makespan + 50);
  assert.ok(costly.avgTurnaround > schedule(jobs, "fifo").avgTurnaround, "worse than even FIFO");
});

test("sched: STCF is never beaten on average turnaround when switching is free", () => {
  for (const p of ["convoy", "late", "mixed"] as const) {
    const all = allSchedules({ jobs: preset(p), quantum: 10, switchCost: 0 });
    const stcf = all.find((s) => s.policy === "stcf")!;
    for (const s of all) assert.ok(stcf.avgTurnaround <= s.avgTurnaround + 1e-9, `${p} ${s.policy}`);
  }
});

test("sched: every job finishes and CPU time adds up", () => {
  const jobs = preset("mixed");
  for (const p of ["fifo", "sjf", "stcf", "rr"] as const) {
    const s = schedule(jobs, p, 5, 1);
    const busy = s.segs.filter((g) => typeof g.job === "number").reduce((a, g) => a + g.end - g.start, 0);
    assert.equal(busy, jobs.reduce((a, j) => a + j.run, 0), p);
    for (const st of s.stats) assert.ok(st.completion < 5000);
  }
});

test("sched: editing jobs clamps values, and the guess locks once the reader runs", () => {
  let s = run(init(), { type: "guess", guess: "80" }, { type: "run", id: 1, value: 9999 }, { type: "arrival", id: 2, value: -5 });
  assert.equal(s.jobs.find((j) => j.id === 1)!.run, 200);
  assert.equal(s.jobs.find((j) => j.id === 2)!.arrival, 0);
  assert.equal(s.preset, null);
  s = run(s, { type: "go" }, { type: "guess", guess: "50" });
  assert.equal(s.guess, "80");
  s = run(s, { type: "add", kind: "interactive" }, { type: "add", kind: "batch" }, { type: "add", kind: "batch" }, { type: "add", kind: "batch" });
  assert.equal(s.jobs.length, 6, "capped at six jobs");
  s = run(s, { type: "quantum", value: 1 }, { type: "switchCost", value: 1 });
  assert.ok(s.brokeRR);
  assert.equal(run(s, { type: "reset" }).jobs.length, 3);
});

test("sched: the verdict names the winners on the reader's jobs", () => {
  const v = verdict(allSchedules({ jobs: preset("convoy"), quantum: 10, switchCost: 0 }));
  assert.equal(v.fifo.avgTurnaround, 110);
  assert.ok(["sjf", "stcf"].includes(v.turnaround.policy));
  assert.ok(v.response.avgResponse <= 10);
});
