import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOW_MS, TIMEOUT_MS, challengeDone, init, step, waitingLive, zombies, type Action, type State } from "../src/playgrounds/observer/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("observer: healthy listeners, both designs confirm the order", () => {
  const s = run(init(), { type: "place" });
  assert.equal(s.inproc.last!.customer, "ok");
  assert.equal(s.queue.last!.customer, "ok");
  assert.deepEqual(s.inproc.last!.hops.map((h) => h.result), ["ok", "ok", "ok"]);
  assert.ok(s.inproc.last!.ms > s.queue.last!.ms, "in-process pays for every listener");
});

test("observer: a throwing listener fails the customer and skips the listeners after it (in-process only)", () => {
  const s = run(init(), { type: "setMode", sub: "email", mode: "throws" }, { type: "place" });
  assert.equal(s.inproc.last!.customer, "error");
  assert.deepEqual(s.inproc.last!.hops.map((h) => h.result), ["threw", "skipped", "skipped"]);
  assert.equal(s.inproc.tally.lost, 3);
  assert.equal(s.queue.last!.customer, "ok");
  assert.equal(waitingLive(s), 1, "the queue keeps the email message for a retry");
  assert.ok(challengeDone(s, "throw"));
});

test("observer: a slow listener pushes the in-process checkout past the timeout", () => {
  const s = run(init(), { type: "toggleSub", sub: "fraud" }, { type: "setMode", sub: "fraud", mode: "slow" }, { type: "place" });
  assert.ok(s.inproc.last!.ms >= SLOW_MS);
  assert.equal(s.inproc.last!.customer, "timeout");
  assert.ok(s.queue.last!.ms < TIMEOUT_MS);
  assert.ok(challengeDone(s, "slow"));
});

test("observer: forgetting to unsubscribe leaves closed tabs being called on every order", () => {
  const s = run(init(),
    { type: "setUnsubscribeOnClose", on: false },
    { type: "openPanel" }, { type: "openPanel" },
    { type: "closePanel", n: 1 }, { type: "closePanel", n: 2 },
    { type: "place", count: 5 });
  assert.equal(zombies(s), 2);
  assert.equal(s.inproc.tally.zombieCalls, 10);
  assert.equal(s.queue.tally.abandoned, 10);
  assert.ok(challengeDone(s, "zombie"));
});

test("observer: unsubscribing on close leaves no zombies", () => {
  const s = run(init(), { type: "openPanel" }, { type: "closePanel", n: 1 }, { type: "place", count: 5 });
  assert.equal(zombies(s), 0);
  assert.equal(s.inproc.tally.zombieCalls, 0);
});

test("observer: after a fix, the queue delivers what it held; in-process losses stay lost", () => {
  let s = run(init(), { type: "setMode", sub: "email", mode: "throws" }, { type: "place", count: 3 });
  const lost = s.inproc.tally.lost;
  s = run(s, { type: "setMode", sub: "email", mode: "ok" });
  assert.equal(waitingLive(s), 0);
  assert.equal(s.queue.tally.caughtUp, 3);
  assert.equal(s.inproc.tally.lost, lost);
  assert.ok(challengeDone(s, "recover"));
});

test("observer: a new subscriber is notified last", () => {
  const s = run(init(), { type: "toggleSub", sub: "email" }, { type: "toggleSub", sub: "email" }, { type: "place" });
  assert.deepEqual(s.inproc.last!.hops.map((h) => h.key), ["inventory", "analytics", "email"]);
});
