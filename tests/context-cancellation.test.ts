import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, CHECK_EVERY, ERROR_AT, GOALS, START, ctxStatus, init, simulate, step, workStatus, type Action, type CtxNode, type State, type WorkNode } from "../src/playgrounds/context-cancellation/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const node = <T extends CtxNode | WorkNode>(s: State, id: string) => s.outcome.nodes.find((n) => n.id === id) as T;

test("context-cancellation: the error response waits for the goroutine that ignores ctx", () => {
  const s = run(init(), { type: "guess", guess: "250" }, { type: "run" });
  assert.equal(ANSWER, "250");
  assert.equal(s.outcome.respondAt, 250);
  assert.equal(s.outcome.status, 500);
  assert.equal(node<CtxNode>(s, "group").doneAt, ERROR_AT, "the group's Done closes at the error");
  assert.equal(node<WorkNode>(s, "inventory").end, ERROR_AT, "inventory checks ctx and stops at once");
  assert.equal(node<WorkNode>(s, "fraud").end, 250, "fraud ignores ctx and runs to the end");
  assert.equal(node<WorkNode>(s, "fraud").wasted, 190);
  // the guess is locked once the request has run
  assert.equal(run(s, { type: "guess", guess: "60" }).guess, "250");
});

test("context-cancellation: cancel flows down, never up; the parent stays open after the group is cancelled", () => {
  const s = init();
  assert.equal(ctxStatus(node<CtxNode>(s, "group"), 100), "closed");
  assert.equal(ctxStatus(node<CtxNode>(s, "handler"), 100), "open");
  assert.equal(ctxStatus(node<CtxNode>(s, "req"), 100), "open");
  assert.equal(workStatus(node<WorkNode>(s, "fraud"), 100), "burning");
});

test("context-cancellation: making fraud check ctx gets the error out within one check interval", () => {
  const s = run(init(), { type: "fixFraud", on: true }, { type: "run" });
  assert.equal(s.outcome.respondAt, ERROR_AT + CHECK_EVERY);
  assert.ok(GOALS[0].met(s.outcome, s.config));
  assert.equal(s.baseline.respondAt, 250, "the baseline keeps the starting handler for comparison");
});

test("context-cancellation: context.Background() cuts recs out of the tree; passing ctx stops it on return", () => {
  const before = init();
  const recs = node<WorkNode>(before, "recs");
  assert.equal(recs.parent, null);
  assert.equal(recs.end, 500);
  assert.deepEqual(before.outcome.runningAtResponse, ["recs"]);
  const after = run(init(), { type: "fixFraud", on: true }, { type: "fixRecs", on: true });
  assert.equal(node<WorkNode>(after, "recs").end, after.outcome.respondAt, "defer cancel() on return stops it");
  assert.deepEqual(after.outcome.runningAtResponse, []);
  assert.ok(GOALS[1].met(after.outcome, after.config));
  assert.equal(after.outcome.wasted, CHECK_EVERY);
});

test("context-cancellation: WithoutCancel keeps the audit write running after every context above it is done", () => {
  const s = run(init(), { type: "scenario", scenario: "clientGone" });
  const audit = node<WorkNode>(s, "audit");
  assert.equal(node<CtxNode>(s, "req").doneAt, 100);
  assert.equal(audit.start, s.outcome.respondAt);
  assert.equal(workStatus(audit, audit.start + 10), "detached");
  assert.equal(s.outcome.status, 499);
});

test("context-cancellation: a deadline cancels like any other cause, and the response still waits for fraud", () => {
  const s = run(init(), { type: "scenario", scenario: "none" }, { type: "deadline", deadline: 150 });
  assert.equal(node<CtxNode>(s, "handler").doneAt, 150);
  assert.equal(node<CtxNode>(s, "handler").cause, "deadline exceeded");
  assert.equal(s.outcome.status, 504);
  assert.equal(s.outcome.respondAt, 250);
  const fixed = run(s, { type: "fixFraud", on: true });
  assert.equal(fixed.outcome.respondAt, 155);
  // with a generous deadline and no failure, nothing is cancelled early
  const ok = simulate({ ...START, scenario: "none", deadline: 300 });
  assert.equal(ok.status, 200);
  assert.equal(ok.respondAt, 250);
});

test("context-cancellation: time is clamped, and reaching the response marks the run as played", () => {
  let s = run(init(), { type: "time", t: 9999 });
  assert.equal(s.time, 600);
  assert.equal(s.played, true);
  s = run(init(), { type: "time", t: 100 });
  assert.equal(s.played, false);
});
