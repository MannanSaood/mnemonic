import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGES, CORES, JOBS, MIXED_TARGET_MS, SWITCH_MS, init, revealed, simulate, step, type Action, type Config, type State,
} from "../src/playgrounds/concurrency-and-the-gil/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const sim = (c: Partial<Config>) => simulate({ workload: "cpu", model: "threads", build: "gil", workers: 1, ...c });

test("concurrency-and-the-gil: CPU work on threads gets no faster under the GIL", () => {
  const one = sim({ workers: 1 }), eight = sim({ workers: 8 });
  assert.equal(one.makespan, eight.makespan);
  assert.equal(eight.coreUse, 25, "one core of four");
  assert.ok(Math.max(...eight.busy) === 1, "never more than one thread runs Python");
  assert.ok(eight.waitMs > 1000, "threads spend their time waiting for the GIL");
});

test("concurrency-and-the-gil: processes use every core, at a start-up cost", () => {
  const procs = sim({ model: "processes", workers: CORES });
  const threads = sim({ workers: CORES });
  assert.ok(procs.makespan * 3 < threads.makespan);
  assert.ok(procs.makespan > (JOBS * 40) / CORES, "start-up and pickling are not free");
  assert.ok(Math.max(...procs.busy) === CORES);
});

test("concurrency-and-the-gil: the free-threaded build runs threads in parallel, a little slower per thread", () => {
  const ft1 = sim({ build: "free", workers: 1 }), gil1 = sim({ workers: 1 });
  assert.ok(ft1.makespan > gil1.makespan, "single-thread overhead");
  assert.ok(sim({ build: "free", workers: 4 }).makespan * 3 < gil1.makespan);
});

test("concurrency-and-the-gil: I/O work overlaps fine on threads and asyncio", () => {
  const io1 = sim({ workload: "io", workers: 1 }), io8 = sim({ workload: "io", workers: 8 });
  assert.ok(io8.makespan * 6 < io1.makespan);
  const aio8 = sim({ workload: "io", model: "asyncio", workers: 8 });
  assert.ok(aio8.makespan * 6 < io1.makespan);
});

test("concurrency-and-the-gil: CPU work in asyncio blocks the loop, and the probe waits", () => {
  const aio = sim({ model: "asyncio", workers: 4 });
  assert.ok(aio.probeWorst > 30);
  const threads = sim({ workers: 4 });
  assert.ok(threads.probeWorst <= SWITCH_MS + 3, "under the GIL the probe waits about one switch interval");
});

test("concurrency-and-the-gil: the mixed batch needs processes (or parallel threads) to beat the target", () => {
  assert.ok(sim({ workload: "mixed", workers: 16 }).makespan > MIXED_TARGET_MS);
  assert.ok(sim({ workload: "mixed", model: "asyncio", workers: 16 }).makespan > MIXED_TARGET_MS);
  assert.ok(sim({ workload: "mixed", model: "processes", workers: 8 }).makespan < MIXED_TARGET_MS);
});

test("concurrency-and-the-gil: the guided path meets every challenge", () => {
  let s = run(init(), { type: "guess", guess: "8x" }, { type: "guess", guess: "same" });
  assert.equal(s.guess, "8x", "the first guess is locked");
  assert.equal(revealed(s), false);
  s = run(s, { type: "workers", workers: 8 });
  assert.equal(revealed(s), true);
  s = run(s, { type: "model", model: "processes" }, { type: "model", model: "asyncio" }, { type: "workload", workload: "mixed" }, { type: "model", model: "processes" });
  assert.ok(CHALLENGES.every((c) => c.met(s.runs)));
  assert.equal(new Set(s.runs.map((r) => r.key)).size, s.runs.length, "one row per configuration");
});
