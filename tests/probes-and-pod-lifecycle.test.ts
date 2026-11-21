import { test } from "node:test";
import assert from "node:assert/strict";
import { DB_DOWN, LAG, NAIVE, init, simulate, step, type Settings, type State } from "../src/playgrounds/probes-and-pod-lifecycle/model.ts";

const sim = (p: Partial<Settings>) => simulate({ ...NAIVE, ...p });
const good: Partial<Settings> = { readiness: true, onTerm: "drain", preStop: 5 };

test("probes: without readiness, traffic reaches v2 pods before they listen (predict)", () => {
  const r = sim({});
  assert.ok(r.failed.booting > 300, `booting failures: ${r.failed.booting}`);
  assert.ok(r.rolloutDone !== null && r.rolloutDone < 25, "the rollout 'finishes' while every new pod is still booting");
});

test("probes: readiness removes the boot failures but not the shutdown race", () => {
  const r = sim({ readiness: true });
  assert.equal(r.failed.booting, 0);
  assert.ok(r.failed.refused + r.failed.killed > 0);
});

test("probes: draining alone still loses the requests sent during the endpoint lag", () => {
  const r = sim({ readiness: true, onTerm: "drain" });
  assert.equal(r.failed.killed, 0);
  assert.ok(r.failed.refused > 0);
});

test("probes: a preStop sleep at least as long as the lag makes the deploy clean and quick", () => {
  let s: State = step(init(), { type: "set", patch: good });
  s = step(s, { type: "run" });
  assert.equal(s.run!.avoidable, 0);
  assert.ok(s.run!.shutdown! <= 10);
  assert.equal(s.found.clean, true);
  assert.equal(s.found.quick, true);
  const short = sim({ ...good, preStop: LAG - 1 });
  assert.ok(short.avoidable > 0, "a preStop shorter than the lag still drops requests");
});

test("probes: ignoring SIGTERM is clean but every old pod waits for SIGKILL at the grace deadline", () => {
  const r = sim({ readiness: true, onTerm: "ignore" });
  assert.equal(r.avoidable, 0);
  assert.equal(r.shutdown, NAIVE.grace);
  assert.ok(r.pods.some((p) => p.marks.some((m) => m.kind === "sigkill")));
});

test("probes: preStop longer than the grace period gets 2 extra seconds, then SIGKILL", () => {
  const r = sim({ readiness: true, preStop: 40, grace: 30 });
  assert.equal(r.shutdown, 32);
});

test("probes: liveness that checks the database restarts every pod during an outage", () => {
  let s = step(init(), { type: "set", patch: { ...good, dbOutage: true } });
  s = step(s, { type: "run" });
  const r = s.run!;
  const restarted = r.pods.filter((p) => p.marks.some((m) => m.kind === "restart" && m.t >= DB_DOWN[0]));
  assert.equal(restarted.length, 3);
  assert.ok(r.avoidable > 0, "the pods are still booting when the database comes back");
  assert.equal(s.found.storm, true);
});

test("probes: liveness on the process only, readiness on the database: no restarts, only the outage's own cost", () => {
  let s = step(init(), { type: "set", patch: { ...good, dbOutage: true, liveDb: false } });
  s = step(s, { type: "run" });
  assert.equal(s.run!.restarts, 0);
  assert.equal(s.run!.avoidable, 0);
  assert.ok(s.run!.failed.database > 0);
  assert.equal(s.found.survived, true);
});

test("probes: a slow boot without a startup probe crash-loops and stalls the rollout; a startup probe fixes it", () => {
  let s = step(init(), { type: "set", patch: { ...good, boot: 45 } });
  s = step(s, { type: "run" });
  assert.equal(s.run!.rolloutDone, null);
  assert.ok(s.run!.pods.some((p) => p.version === 2 && p.crashLoop));
  assert.equal(s.found.crashLoop, true);
  const fixed = sim({ ...good, boot: 45, startup: true });
  assert.notEqual(fixed.rolloutDone, null);
  assert.equal(fixed.restarts, 0);
});

test("probes: settings re-run once a run exists, previous is kept, and reset clears all", () => {
  let s = step(init(), { type: "run" });
  const first = s.run!.avoidable;
  s = step(s, { type: "set", patch: { readiness: true } });
  assert.equal(s.previous!.failed, first);
  assert.ok(s.run!.avoidable < first);
  assert.deepEqual(step(s, { type: "reset" }), init());
});
