import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeDone, init, leftovers, predictRevealed, step, summarize, timeline, worldAt,
  type Action, type Config, type State,
} from "../src/playgrounds/workflows-and-sagas/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const base: Config = { style: "orch", failAt: 0, compensate: true, crash: false, durable: true, deaf: false };
const cfg = (patch: Partial<Config>): Config => ({ ...base, ...patch });

test("sagas: with nothing failing, both styles approve the order and send a confirmation", () => {
  for (const style of ["orch", "chor"] as const) {
    const s = summarize(cfg({ style }));
    assert.equal(s.end.order, "approved");
    assert.equal(s.end.email, "confirmed");
    assert.equal(s.end.charged, 85_00);
    assert.deepEqual(s.leftovers, []);
    assert.equal(s.compensations, 0);
  }
});

test("sagas: a failure at the last step runs three compensations and ends clean (the predicted answer)", () => {
  for (const style of ["orch", "chor"] as const) {
    const s = summarize(cfg({ style, failAt: 3 }));
    assert.equal(s.compensations, 3);
    assert.equal(s.end.order, "rejected");
    assert.equal(s.end.refunded, 85_00);
    assert.equal(s.end.reserved, 0);
    assert.deepEqual(s.leftovers, []);
  }
  const st = run(init(), { type: "predict", value: "3" }, { type: "run" });
  assert.ok(predictRevealed(st));
  assert.ok(challengeDone(st, "clean"));
});

test("sagas: compensations run in reverse order of the forward steps", () => {
  const labels = timeline(cfg({ failAt: 3 })).filter((m) => m.compensation).map((m) => m.label);
  assert.deepEqual(labels, ["Refund $85", "ReleaseStock", "RejectOrder"]);
});

test("sagas: a failure at the first step has only the order to reject", () => {
  assert.equal(summarize(cfg({ failAt: 1 })).compensations, 1);
  assert.equal(summarize(cfg({ style: "chor", failAt: 1 })).compensations, 1);
});

test("sagas: without compensations the rejected order leaves stock and money behind", () => {
  const s = summarize(cfg({ failAt: 3, compensate: false }));
  assert.equal(s.end.order, "rejected");
  assert.deepEqual(s.leftovers, ["1 unit of stock held", "$85 charged"]);
  const st = run(init(), { type: "fail", at: 2 }, { type: "compensate", on: false }, { type: "run" });
  assert.ok(challengeDone(st, "noComp"));
});

test("sagas: the half-done window is visible while the order is pending", () => {
  const msgs = timeline(cfg({ failAt: 3 }));
  const s = summarize(cfg({ failAt: 3 }));
  assert.ok(s.halfDoneSteps > 0);
  assert.equal(worldAt(msgs, 0).order, "none");
});

test("sagas: an orchestrator crash without a durable log strands the charge; with one it recovers", () => {
  const lost = summarize(cfg({ failAt: 3, crash: true, durable: false }));
  assert.equal(lost.end.order, "pending");
  assert.ok(lost.leftovers.includes("$85 charged"));
  const kept = summarize(cfg({ failAt: 3, crash: true, durable: true }));
  assert.deepEqual(kept.leftovers, []);
  const st = run(init(), { type: "crash", on: true }, { type: "durable", on: false }, { type: "run" });
  assert.ok(challengeDone(st, "crash"));
});

test("sagas: in choreography a service that misses the failure event keeps its stock", () => {
  const s = summarize(cfg({ style: "chor", failAt: 2, deaf: true }));
  assert.deepEqual(s.leftovers, ["1 unit of stock held"]);
  const st = run(init(), { type: "style", style: "chor" }, { type: "deaf", on: true }, { type: "run" });
  assert.ok(challengeDone(st, "deaf"));
});

test("sagas: choreography sends fewer messages, orchestration keeps the state in one place", () => {
  const o = summarize(cfg({ failAt: 3 })), c = summarize(cfg({ style: "chor", failAt: 3 }));
  assert.ok(c.messages < o.messages);
  assert.equal(o.stateIn, "the saga log");
  assert.ok(c.stateIn.startsWith("nowhere"));
});

test("sagas: stepping message by message reaches the same end as running; changing the config rewinds", () => {
  let s = init();
  const len = timeline(s.config).length;
  for (let i = 0; i < len + 2; i++) s = run(s, { type: "next" });
  assert.equal(s.cursor, len);
  assert.equal(s.finished.length, 1, "a finished run is recorded once");
  assert.deepEqual(leftovers(worldAt(timeline(s.config), s.cursor)), []);
  s = run(s, { type: "fail", at: 1 });
  assert.equal(s.cursor, 0);
  assert.deepEqual(run(s, { type: "reset" }), init());
});
