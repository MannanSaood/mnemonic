import { test } from "node:test";
import assert from "node:assert/strict";
import { CORES, JOBS, LOCAL_CAP, PROBE_AT, init, queued, running, simulate, step, type Action, type State } from "../src/playgrounds/gmp-scheduler/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ticks = (s: State, n: number) => { for (let i = 0; i < n; i++) s = step(s, { type: "tick" }); return s; };

test("gmp: never more goroutines running than Ps", () => {
  for (const procs of [1, 2, 4, 8]) {
    let s = run(init(), { type: "procs", procs }, { type: "start" });
    for (let i = 0; i < 80; i++) {
      s = step(s, { type: "tick" });
      assert.ok(running(s) <= procs, `running ${running(s)} > ${procs} Ps`);
    }
  }
});

test("gmp: 64 goroutines finish the batch no sooner than 4 workers on 4 Ps", () => {
  const many = simulate(64, 4), few = simulate(4, 4);
  assert.equal(many.batchMs, few.batchMs);
  assert.equal(many.batchMs, 325);
});

test("gmp: the extra goroutines make /healthz wait much longer", () => {
  const many = simulate(64, 4), few = simulate(4, 4);
  assert.ok(many.probeWaitMs >= 5 * few.probeWaitMs, `${many.probeWaitMs} vs ${few.probeWaitMs}`);
  assert.ok(many.maxQueued > 60);
  assert.ok(few.maxQueued <= 4);
});

test("gmp: probe wait grows with the number of goroutines at fixed GOMAXPROCS", () => {
  const waits = [1, 4, 16, 64].map((n) => simulate(n, 4).probeWaitMs);
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] >= waits[i - 1], waits.join(","));
});

test("gmp: more Ps speed up CPU work only up to the number of cores", () => {
  const t1 = simulate(64, 1).batchMs, t2 = simulate(64, 2).batchMs, t4 = simulate(64, 4).batchMs, t8 = simulate(64, 8).batchMs;
  assert.ok(t2 < t1 && t4 < t2);
  assert.equal(t8, t4, `GOMAXPROCS 8 on ${CORES} cores is no faster`);
});

test("gmp: one worker leaves the other Ps idle", () => {
  assert.ok(simulate(1, 4).batchMs > 3 * simulate(4, 4).batchMs);
});

test("gmp: spawning 64 goroutines overflows P0's queue into the global queue, and idle Ps take from it", () => {
  let s = run(init(), { type: "start" });
  assert.ok(s.ps[0].q.length <= LOCAL_CAP);
  assert.ok(s.global.length > 0);
  assert.equal(queued(s), JOBS);
  s = ticks(s, 1);
  assert.equal(running(s), 4, "every P found work in the first tick");
});

test("gmp: the health check arrives on schedule and is recorded once", () => {
  let s = run(init(), { type: "spawn", spawn: 4 }, { type: "start" });
  s = ticks(s, PROBE_AT + 1);
  assert.ok(s.probeId !== null);
  s = step(s, { type: "finish" });
  assert.equal(s.runs.length, 1);
  s = ticks(s, 5);
  assert.equal(s.runs.length, 1);
});

test("gmp: lowering GOMAXPROCS mid-run moves the removed Ps' goroutines to the global queue", () => {
  let s = run(init(), { type: "spawn", spawn: 16 }, { type: "start" });
  s = ticks(s, 3);
  const before = queued(s) + running(s);
  s = step(s, { type: "procs", procs: 2 });
  assert.equal(s.ps.length, 2);
  assert.equal(queued(s) + running(s), before, "no goroutine is lost");
  s = step(s, { type: "finish" });
  assert.equal(s.jobsDone, JOBS);
});

test("gmp: the guided comparison records both runs and keeps the guess", () => {
  let s = run(init(), { type: "guess", guess: "same" }, { type: "finish" });
  s = run(s, { type: "spawn", spawn: 4 }, { type: "finish" });
  assert.equal(s.runs.length, 2);
  assert.equal(s.guess, "same");
  assert.equal(run(s, { type: "guess", guess: "pool" }).guess, "same");
  assert.equal(run(s, { type: "reset" }).runs.length, 0);
});
