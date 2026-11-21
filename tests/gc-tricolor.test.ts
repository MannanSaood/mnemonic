import { test } from "node:test";
import assert from "node:assert/strict";
import { greys, init, play, reachable, step, type Action } from "../src/playgrounds/gc-tricolor/model.ts";

const S = (id: string): Action => ({ type: "scan", id });
const HIDE: Action[] = [{ type: "start" }, S("sessions"), S("u42"), { type: "mutate", m: "merge" }, { type: "finish" }, { type: "sweep" }];

test("gc: starting a cycle shades what the roots point to", () => {
  const s = play(true, { type: "start" });
  assert.deepEqual(greys(s).sort(), ["req", "sessions"]);
  assert.equal(s.objs.u42.color, "white");
});

test("gc: with no mutation, sweep frees exactly the unreachable objects", () => {
  for (const barrier of [true, false]) {
    const s = play(barrier, { type: "start" }, { type: "finish" }, { type: "sweep" });
    assert.deepEqual(s.last!.freedLive, []);
    assert.equal(s.last!.freedGarbage, 2, "Session x9 and its cart");
    assert.equal(s.objs.x9.freed, true);
    assert.equal(s.objs.cart.freed, false);
  }
});

test("gc: only a grey object can be scanned", () => {
  const s = play(true, { type: "start" });
  assert.equal(step(s, S("u42")), s, "white: not yet");
  const s2 = step(s, S("sessions"));
  assert.equal(s2.objs.sessions.color, "black");
  assert.equal(step(s2, S("sessions")), s2, "black: already done");
});

test("gc: barrier off, moving the only pointer behind a black object frees a live object", () => {
  const s = play(false, ...HIDE);
  assert.deepEqual(s.last!.freedLive.sort(), ["Cart g7", "LineItem"]);
  assert.ok(reachable(s).has("cart"), "Session u42 still points at the freed cart");
  assert.equal(s.objs.cart.freed, true);
});

test("gc: barrier on, the same moves keep the cart alive", () => {
  const s = play(true, ...HIDE);
  assert.deepEqual(s.last!.freedLive, []);
  assert.equal(s.objs.cart.freed, false);
  assert.ok(s.last!.shades >= 1);
});

test("gc: barrier off is only dangerous in that order: merge before scanning u42 is safe", () => {
  const s = play(false, { type: "start" }, S("sessions"), { type: "mutate", m: "merge" }, { type: "finish" }, { type: "sweep" });
  assert.deepEqual(s.last!.freedLive, []);
});

test("gc: objects allocated during marking are black and survive", () => {
  const s = play(false, ...HIDE.slice(0, 3), { type: "mutate", m: "add" }, { type: "finish" }, { type: "sweep" });
  assert.equal(s.objs.item2.isNew, true);
  assert.equal(s.objs.item2.freed, false);
});

test("gc: deleting a pointer during marking leaves floating garbage with the barrier on", () => {
  const s = play(true, { type: "start" }, S("sessions"), { type: "mutate", m: "drop" }, { type: "finish" }, { type: "sweep" });
  assert.equal(reachable(s).has("g7"), false);
  assert.equal(s.objs.g7.freed, false, "the deletion barrier shaded it, so it waits for the next cycle");
  assert.ok(s.last!.floating >= 1);
});

test("gc: marking work grows with live objects and pointers, not garbage", () => {
  const s = play(true, { type: "start" }, { type: "finish" });
  assert.equal(s.scanned, 8, "every live object is scanned once");
  assert.equal(s.objs.x9.color, "white", "garbage is never visited");
});

test("gc: the prediction locks after a barrier-off run with the merge", () => {
  let s = step(init(), { type: "guess", guess: "survives" });
  s = [...[{ type: "barrier", on: false } as Action], ...HIDE].reduce(step, s);
  assert.equal(step(s, { type: "guess", guess: "freed" }).guess, "survives");
  s = step(s, { type: "again" });
  assert.equal(s.phase, "idle");
  assert.equal(s.runs.length, 1);
});
