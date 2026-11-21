import { test } from "node:test";
import assert from "node:assert/strict";
import {
  N, RTT, clean, compare, init, randomPlan, simulate, step,
  type Action, type Fault, type State,
} from "../src/playgrounds/reliable-transfer-principles/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const plan = (i: number, f: Fault): Fault[] => clean().map((_, j) => (j === i ? f : "ok"));

test("reliable-transfer: stop-and-wait costs one round trip per message", () => {
  const r = simulate({ protocol: "sw", window: 4, faults: clean(), seqCheck: true });
  assert.equal(r.doneAt, N * RTT);
  assert.equal(r.retransmissions, 0);
  assert.ok(r.utilisation < 0.1);
});

test("reliable-transfer: a window keeps the link busy and beats stop-and-wait", () => {
  const sw = simulate({ protocol: "sw", window: 4, faults: clean(), seqCheck: true });
  const gbn4 = simulate({ protocol: "gbn", window: 4, faults: clean(), seqCheck: true });
  const gbn5 = simulate({ protocol: "gbn", window: 5, faults: clean(), seqCheck: true });
  assert.ok(gbn4.doneAt < sw.doneAt / 3);
  assert.ok(gbn5.doneAt * 4 <= sw.doneAt);
  const s = run(init(), { type: "protocol", protocol: "gbn" }, { type: "window", window: 5 }, { type: "toEnd" });
  assert.ok(s.done.includes("pipe"));
});

test("reliable-transfer: one loss, go-back-N resends the tail, selective repeat only the gap", () => {
  const gbn = simulate({ protocol: "gbn", window: 4, faults: plan(3, "drop"), seqCheck: true });
  const sr = simulate({ protocol: "sr", window: 4, faults: plan(3, "drop"), seqCheck: true });
  assert.equal(gbn.retransmissions, 4);
  assert.equal(sr.retransmissions, 1);
  assert.ok(sr.maxBuffered > 0, "selective repeat holds out-of-order packets");
  assert.equal(gbn.dupDelivered + sr.dupDelivered + gbn.missing + sr.missing, 0);
  // the discarded early arrivals are what go-back-N pays for
  assert.ok(gbn.packets.some((p) => p.kind === "data" && p.outcome === "discarded"));
});

test("reliable-transfer: the predict reveals after a go-back-N run with one loss", () => {
  let s = run(init(), { type: "predict", value: "after" }, { type: "protocol", protocol: "gbn" }, { type: "preset", name: "lose3" });
  assert.equal(s.revealed, false);
  s = run(s, { type: "toEnd" });
  assert.equal(s.revealed, true);
  s = run(s, { type: "protocol", protocol: "sr" }, { type: "toEnd" });
  assert.ok(s.done.includes("gbnWaste"));
});

test("reliable-transfer: cumulative ACKs cover a lost ACK, except the last one", () => {
  const mid = simulate({ protocol: "gbn", window: 4, faults: plan(2, "ackdrop"), seqCheck: true });
  assert.equal(mid.retransmissions, 0);
  const last = simulate({ protocol: "gbn", window: 4, faults: plan(N - 1, "ackdrop"), seqCheck: true });
  assert.equal(last.retransmissions, 1);
  const sr = simulate({ protocol: "sr", window: 4, faults: plan(2, "ackdrop"), seqCheck: true });
  assert.equal(sr.retransmissions, 1, "selective repeat ACKs each packet, so it must resend");
  const s = run(init(), { type: "protocol", protocol: "gbn" }, { type: "preset", name: "loseAck" }, { type: "toEnd" });
  assert.ok(s.done.includes("cumulative"));
});

test("reliable-transfer: without the sequence check, a lost ACK becomes a duplicate in the app", () => {
  const off = simulate({ protocol: "sw", window: 4, faults: plan(2, "ackdrop"), seqCheck: false });
  const on = simulate({ protocol: "sw", window: 4, faults: plan(2, "ackdrop"), seqCheck: true });
  assert.equal(off.dupDelivered, 1);
  assert.equal(on.dupDelivered, 0);
  const s = run(init(), { type: "seqCheck", on: false }, { type: "preset", name: "loseAck" }, { type: "toEnd" });
  assert.ok(s.done.includes("duplicate"));
});

test("reliable-transfer: a late packet causes a needless resend that the receiver discards", () => {
  const r = simulate({ protocol: "sw", window: 4, faults: plan(3, "delay"), seqCheck: true });
  assert.equal(r.retransmissions, 1);
  assert.ok(r.packets.some((p) => p.kind === "data" && !p.retrans && p.outcome === "duplicate"));
  assert.equal(r.dupDelivered, 0);
});

test("reliable-transfer: a network copy is caught by the sequence check", () => {
  for (const protocol of ["sw", "gbn", "sr"] as const) {
    assert.equal(simulate({ protocol, window: 4, faults: plan(4, "dup"), seqCheck: true }).dupDelivered, 0);
    assert.equal(simulate({ protocol, window: 4, faults: plan(4, "dup"), seqCheck: false }).dupDelivered, 1);
  }
});

test("reliable-transfer: every protocol delivers everything exactly once under random trouble", () => {
  for (const seed of [1, 7, 42, 99, 1234]) {
    const faults = randomPlan(seed);
    for (const protocol of ["sw", "gbn", "sr"] as const) {
      const r = simulate({ protocol, window: 4, faults, seqCheck: true });
      assert.ok(r.complete, `${protocol} seed ${seed} completes`);
      assert.equal(r.missing, 0);
      assert.equal(r.dupDelivered, 0);
      assert.deepEqual(r.deliveries.map((d) => d.seq), Array.from({ length: N }, (_, i) => i));
    }
  }
});

test("reliable-transfer: ticking plays the clock forward; changing the design rewinds it", () => {
  let s = run(init(), { type: "tick", ms: 10 }, { type: "tick", ms: 10 });
  assert.equal(s.t, 20);
  s = run(s, { type: "cycleFault", seq: 0 });
  assert.equal(s.faults[0], "drop");
  assert.equal(s.t, 0);
  const c = compare(s);
  assert.ok(c.sw.doneAt > c.gbn.doneAt);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
