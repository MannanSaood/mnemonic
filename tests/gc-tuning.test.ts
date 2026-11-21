import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTAINER, OVERHEAD, goalFor, init, simulate, step, type Action, type State } from "../src/playgrounds/gc-tuning/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("tuning: the heap target is the live heap times 1 + GOGC/100", () => {
  assert.equal(goalFor({ gogc: 100, limit: null, peak: 0 }, 200), 400);
  assert.equal(goalFor({ gogc: 50, limit: null, peak: 0 }, 200), 300);
  assert.equal(goalFor({ gogc: 100, limit: 460, peak: 0 }, 300), 460 - OVERHEAD, "the limit caps the target");
  assert.equal(goalFor({ gogc: null, limit: null, peak: 0 }, 300), Infinity);
});

test("tuning: default GOGC with no limit lets a 300 MiB burst reach twice the live heap and get OOM-killed", () => {
  const r = simulate({ gogc: 100, limit: null, peak: 300 });
  assert.ok(r.oomAt !== null);
  assert.ok(r.peakTotal > CONTAINER);
});

test("tuning: GOMEMLIMIT at 90% of the container survives the same burst with more cycles", () => {
  const off = simulate({ gogc: 100, limit: null, peak: 300 });
  const on = simulate({ gogc: 100, limit: 460, peak: 300 });
  assert.equal(on.oomAt, null);
  assert.ok(on.peakTotal <= 470);
  assert.ok(on.cycles.length > off.cycles.length);
});

test("tuning: a quiet service runs the same with or without the limit", () => {
  const a = simulate({ gogc: 100, limit: null, peak: 100 }), b = simulate({ gogc: 100, limit: 460, peak: 100 });
  assert.equal(a.cycles.length, b.cycles.length);
});

test("tuning: lowering GOGC also survives, but pays GC CPU all the time", () => {
  const low = simulate({ gogc: 50, limit: null, peak: 300 }), lim = simulate({ gogc: 100, limit: 460, peak: 300 });
  assert.equal(low.oomAt, null);
  assert.ok(low.avgGcShare > lim.avgGcShare);
});

test("tuning: GOGC off with no limit grows until the pod is killed", () => {
  const r = simulate({ gogc: null, limit: null, peak: 100 });
  assert.equal(r.cycles.length, 0);
  assert.ok(r.oomAt !== null);
});

test("tuning: GOGC off with a limit collects only as often as the limit needs", () => {
  const off = simulate({ gogc: null, limit: 460, peak: 100 }), def = simulate({ gogc: 100, limit: null, peak: 100 });
  assert.equal(off.oomAt, null);
  assert.ok(off.cycles.length < def.cycles.length / 2);
});

test("tuning: near the limit the GC runs almost back to back and the CPU limiter caps it near 50%", () => {
  const r = simulate({ gogc: 100, limit: 460, peak: 380 });
  assert.equal(r.oomAt, null);
  assert.ok(r.maxGcShare > 0.4 && r.maxGcShare <= 0.56, String(r.maxGcShare));
  assert.ok(r.throughput < 0.85);
});

test("tuning: a limit below the live heap is soft: memory exceeds it instead of thrashing forever", () => {
  const r = simulate({ gogc: 100, limit: 300, peak: 300 });
  assert.ok(r.limiterMs > 0);
  assert.ok(r.peakTotal > 300);
  assert.ok(r.maxGcShare <= 0.56);
});

test("tuning: no setting saves a live heap that does not fit", () => {
  for (const gogc of [50, 100, null]) assert.ok(simulate({ gogc, limit: 460, peak: 440 }).oomAt !== null, String(gogc));
});

test("tuning: runs are recorded only after the first run, one row per setting, and the guess locks", () => {
  let s = run(init(), { type: "gogc", value: 50 }, { type: "guess", guess: "fits" });
  assert.equal(s.runs.length, 0);
  s = run(s, { type: "gogc", value: 100 }, { type: "run" });
  assert.equal(s.runs.length, 1);
  assert.equal(run(s, { type: "guess", guess: "oom" }).guess, "fits");
  s = run(s, { type: "limit", value: 460 }, { type: "limit", value: null }, { type: "limit", value: 460 });
  assert.equal(s.runs.length, 2);
  assert.equal(run(s, { type: "gogc", value: 130 }).gogc, 125, "GOGC snaps to steps of 25");
});
