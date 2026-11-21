import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, init, step, type Action, type State } from "../src/playgrounds/channels-hchan/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("channels-hchan: the predicted send goes straight to the parked receiver, and the sender never waits", () => {
  const s = run(init(), { type: "guess", guess: "direct" }, { type: "send", g: "S1" });
  assert.equal(ANSWER, "direct");
  assert.equal(s.gs.R1.status, "running");
  assert.equal(s.gs.R1.got, "#101");
  assert.equal(s.gs.S1.status, "running");
  assert.equal(s.stats.handoffs, 1);
  assert.equal(s.stats.buffered, 0);
  assert.deepEqual(s.recvq, []);
  // the guess is locked after the first send
  assert.equal(run(s, { type: "guess", guess: "park" }).guess, "direct");
});

test("channels-hchan: unbuffered send with nobody waiting parks the sender; a receive copies off its stack", () => {
  let s = run(init(), { type: "send", g: "S1" }, { type: "send", g: "S2" });
  assert.equal(s.gs.S2.status, "parked");
  assert.deepEqual(s.sendq, [{ g: "S2", v: "#102" }]);
  s = run(s, { type: "recv", g: "R2" });
  assert.equal(s.gs.R2.got, "#102");
  assert.equal(s.gs.S2.status, "running");
  assert.equal(s.stats.handoffs, 2);
  // a parked goroutine cannot act
  const p = run(init(), { type: "send", g: "S1" }, { type: "send", g: "S2" });
  assert.equal(run(p, { type: "send", g: "S2" }), p);
});

test("channels-hchan: a buffer lets senders run ahead by exactly its capacity, then they park", () => {
  let s = run(init(), { type: "setCap", cap: 2 });
  s = run(s, { type: "send", g: "S1" }, { type: "send", g: "S2" });
  assert.equal(s.qcount, 2);
  assert.equal(s.stats.parks, 0);
  assert.equal(s.sendx, 0, "sendx wrapped around");
  s = run(s, { type: "send", g: "S3" });
  assert.equal(s.gs.S3.status, "parked");
  assert.ok(s.done.includes("parkSender"));
});

test("channels-hchan: on a buffered channel, a parked receiver still gets the value directly", () => {
  let s = run(init(), { type: "setCap", cap: 3 }, { type: "recv", g: "R1" });
  assert.equal(s.gs.R1.status, "parked");
  s = run(s, { type: "send", g: "S1" });
  assert.equal(s.gs.R1.got, "#101");
  assert.equal(s.qcount, 0);
  assert.deepEqual(s.buf, [null, null, null]);
  assert.ok(s.done.includes("skipBuffer"));
});

test("channels-hchan: receiving from a full buffer with a parked sender keeps FIFO order", () => {
  let s = run(init(), { type: "setCap", cap: 2 },
    { type: "send", g: "S1" }, { type: "send", g: "S2" }, { type: "send", g: "S3" });
  s = run(s, { type: "recv", g: "R1" });
  assert.equal(s.gs.R1.got, "#101", "oldest value first");
  assert.equal(s.gs.S3.status, "running");
  assert.equal(s.qcount, 2, "buffer still full");
  assert.ok(s.done.includes("refill"));
  s = run(s, { type: "recv", g: "R1" }, { type: "recv", g: "R2" });
  assert.equal(s.gs.R1.got, "#102");
  assert.equal(s.gs.R2.got, "#103");
});

test("channels-hchan: close wakes receivers with the zero value and makes parked senders panic", () => {
  let s = run(init(), { type: "setCap", cap: 0 }, { type: "recv", g: "R1" }, { type: "send", g: "S1" }, { type: "recv", g: "R2" });
  assert.equal(s.gs.R2.status, "parked");
  s = run(s, { type: "close" });
  assert.equal(s.gs.R2.got, "");
  assert.equal(s.gs.R2.ok, false);
  assert.equal(s.gs.R2.status, "running");

  let t = run(init(), { type: "setCap", cap: 1 }, { type: "send", g: "S1" }, { type: "send", g: "S2" });
  t = run(t, { type: "close" });
  assert.equal(t.gs.S2.status, "panicked");
  assert.equal(t.crashed, true);
  assert.ok(t.done.includes("closeWaiters"));
  // buffered values are still delivered after close, then the zero value
  t = run(t, { type: "recv", g: "R1" }, { type: "recv", g: "R2" });
  assert.equal(t.gs.R1.got, "#101");
  assert.equal(t.gs.R2.got, "");
  assert.equal(t.gs.R2.ok, false);
});

test("channels-hchan: send after close and close twice both panic; every operation takes the lock", () => {
  let s = run(init(), { type: "setCap", cap: 1 }, { type: "close" }, { type: "send", g: "S1" });
  assert.equal(s.gs.S1.status, "panicked");
  s = run(s, { type: "close" });
  assert.equal(s.stats.panics, 2);
  assert.equal(s.stats.locks, 3);
});
