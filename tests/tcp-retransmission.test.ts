import { test } from "node:test";
import assert from "node:assert/strict";
import {
  N, clean, dupAcksAt, estimatorAt, init, simulate, step,
  type Action, type Config, type Ev, type Fault, type State,
} from "../src/playgrounds/tcp-retransmission/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const plan = (m: Record<number, Fault>): Fault[] => clean().map((_, i) => m[i + 1] ?? "ok");
const sim = (c: Partial<Config>) => simulate({ baseRtt: 60, jitter: "some", floor: "linux", sack: true, faults: clean(), ...c });
const samples = (evs: Ev[]) => evs.filter((e): e is Extract<Ev, { kind: "sample" }> => e.kind === "sample");

test("tcp-retransmission: the estimator follows RFC 6298 exactly", () => {
  const r = sim({ jitter: "wild" });
  const ss = samples(r.events);
  assert.ok(ss.length > 5);
  const [first, second] = ss;
  assert.equal(first.srtt, first.r);
  assert.equal(first.rttvar, first.r / 2);
  assert.equal(second.rttvar, 0.75 * first.rttvar + 0.25 * Math.abs(first.srtt - second.r));
  assert.equal(second.srtt, 0.875 * first.srtt + 0.125 * second.r);
  for (const s of ss) assert.equal(s.rto, Math.max(200, s.srtt + Math.max(1, 4 * s.rttvar)));
});

test("tcp-retransmission: before any sample the RTO is 1 s, and the floor applies after", () => {
  const r = sim({});
  assert.equal(estimatorAt(r, 0).rto, 1000);
  assert.equal(r.finalRto, 200, "a 60 ms path is held at Linux's 200 ms floor");
  assert.equal(sim({ floor: "rfc" }).finalRto, 1000);
  const long = sim({ baseRtt: 200, jitter: "wild" });
  assert.ok(long.finalRto > 200, "a long, jittery path raises the RTO above the floor");
});

test("tcp-retransmission: a loss in the middle is repaired by three duplicate ACKs, not the timer", () => {
  const r = sim({ faults: plan({ 7: "drop" }) });
  assert.equal(r.fast, 1);
  assert.equal(r.timeouts, 0);
  assert.equal(r.retransmissions, 1);
  const fast = r.events.find((e) => e.kind === "fast")!;
  assert.equal(dupAcksAt(r, fast.t), 3);
  assert.ok(r.doneAt - sim({}).doneAt < 200, "the repair costs less than one RTO");
  const s = run(init(), { type: "predict", value: "dup" }, { type: "setFault", seq: 7, fault: "drop" }, { type: "toEnd" });
  assert.equal(s.revealed, true);
  assert.ok(s.done.includes("fast"));
});

test("tcp-retransmission: losing the last segment leaves no duplicate ACKs, so the timer must fire", () => {
  const r = sim({ faults: plan({ [N]: "drop" }) });
  assert.equal(r.fast, 0);
  assert.equal(r.timeouts, 1);
  assert.ok(r.events.some((e) => e.kind === "timeout" && e.seg === N));
  const s = run(init(), { type: "setFault", seq: N, fault: "drop" }, { type: "toEnd" });
  assert.ok(s.done.includes("tail"));
});

test("tcp-retransmission: every repeated timeout doubles the RTO", () => {
  const r = sim({ faults: plan({ [N]: "drop2" }) });
  const tos = r.events.filter((e): e is Extract<Ev, { kind: "timeout" }> => e.kind === "timeout");
  assert.equal(tos.length, 2);
  assert.equal(tos[0].rto, tos[0].oldRto * 2);
  assert.equal(tos[1].oldRto, tos[0].rto);
  assert.equal(tos[1].rto, tos[1].oldRto * 2);
  const s = run(init(), { type: "setFault", seq: 7, fault: "drop2" }, { type: "toEnd" });
  assert.ok(s.done.includes("backoff"));
});

test("tcp-retransmission: Karn's rule skips samples from segments sent twice", () => {
  const r = sim({ faults: plan({ 7: "drop" }) });
  assert.ok(r.events.some((e) => e.kind === "karn" && e.seg === 7));
  assert.ok(!samples(r.events).some((e) => e.seg === 7));
});

test("tcp-retransmission: a late segment is resent although it was never lost", () => {
  const r = sim({ faults: plan({ 7: "late" }) });
  assert.ok(r.retransmissions >= 1);
  assert.ok(r.needless >= 1, "the late original reaches a receiver that already has it");
  const s = run(init(), { type: "setFault", seq: 7, fault: "late" }, { type: "toEnd" });
  assert.ok(s.done.includes("spurious"));
});

test("tcp-retransmission: SACK repairs several holes in one round trip", () => {
  const holes = plan({ 7: "drop", 8: "drop", 9: "drop" });
  const withSack = sim({ faults: holes });
  const without = sim({ faults: holes, sack: false });
  assert.equal(withSack.timeouts + without.timeouts, 0);
  assert.ok(withSack.doneAt < without.doneAt, "without SACK each partial ACK reveals one hole per round trip");
  assert.ok(without.events.filter((e) => e.kind === "partial").length >= 2);
});

test("tcp-retransmission: without SACK a timeout resends data the receiver already holds", () => {
  const r = sim({ faults: plan({ 7: "drop2" }), sack: false });
  const withSack = sim({ faults: plan({ 7: "drop2" }) });
  assert.ok(r.needless > withSack.needless);
});

test("tcp-retransmission: every plan delivers everything", () => {
  for (const faults of [plan({ 1: "drop2", 5: "late", 9: "drop", 10: "drop", 20: "drop2" }), plan({ 2: "drop", 3: "drop2", 19: "late" })]) {
    for (const sack of [true, false]) for (const floor of ["linux", "rfc"] as const) {
      const r = sim({ faults, sack, floor, jitter: "wild" });
      assert.ok(r.complete);
    }
  }
});

test("tcp-retransmission: ticking plays the clock; changing the path rewinds", () => {
  let s = run(init(), { type: "tick", ms: 30 });
  assert.equal(s.t, 30);
  s = run(s, { type: "rtt", ms: 120 });
  assert.equal(s.t, 0);
  assert.equal(s.baseRtt, 120);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
