import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeDone, drift, init, step, undoTarget, type Action, type State } from "../src/playgrounds/command/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("command: a queued command runs once when the network is fine", () => {
  const s = run(init(), { type: "issue", kind: "refund" }, { type: "work" });
  assert.equal(s.account.refunded, 40);
  assert.equal(s.queue.length, 0);
  assert.equal(drift(s).extraRefund, 0);
});

test("command: a refused connection is safe to retry", () => {
  const s = run(init(), { type: "issue", kind: "refund" }, { type: "setFault", fault: "refused" }, { type: "work" }, { type: "work" });
  assert.equal(s.account.refunded, 40);
  assert.equal(s.retries, 1);
});

test("command: retrying after a lost response without a key refunds twice", () => {
  const s = run(init(), { type: "issue", kind: "refund" }, { type: "setFault", fault: "lost" }, { type: "work" }, { type: "work" });
  assert.equal(s.account.refunded, 80);
  assert.equal(s.intended.refunded, 40);
  assert.equal(s.retryAfterLost?.duplicated, true);
  assert.ok(challengeDone(s, "double"));
});

test("command: with an idempotency key, the retry is recognised and applied once", () => {
  const s = run(init(), { type: "setKeys", on: true }, { type: "issue", kind: "refund" }, { type: "setFault", fault: "lost" }, { type: "work" }, { type: "work" });
  assert.equal(s.account.refunded, 40);
  assert.equal(s.retryAfterLost?.duplicated, false);
  assert.ok(challengeDone(s, "keyed"));
});

test("command: a set-a-value command is naturally idempotent, an add-a-value one is not", () => {
  const plan = run(init(), { type: "issue", kind: "plan" }, { type: "setFault", fault: "lost" }, { type: "work" }, { type: "work" });
  assert.equal(plan.account.plan, "Pro");
  const credit = run(init(), { type: "issue", kind: "credit" }, { type: "setFault", fault: "lost" }, { type: "work" }, { type: "work" });
  assert.equal(credit.account.credit, 50);
  assert.equal(drift(credit).extraCredit, 25);
});

test("command: undo restores the value the command saved before it ran", () => {
  let s = run(init(), { type: "issue", kind: "plan" }, { type: "work" });
  assert.equal(s.account.plan, "Pro");
  s = run(s, { type: "undo" });
  assert.equal(s.account.plan, "Basic");
  assert.ok(challengeDone(s, "undo"));
  assert.equal(undoTarget(s), undefined);
});

test("command: a refund cannot be undone", () => {
  const s = run(init(), { type: "issue", kind: "refund" }, { type: "work" }, { type: "undo" });
  assert.equal(s.account.refunded, 40);
  assert.equal(s.refusedUndo, "refund");
  assert.ok(challengeDone(s, "refuse"));
});

test("command: a command that keeps failing is given up after three attempts", () => {
  const s = run(init(), { type: "issue", kind: "email" },
    { type: "setFault", fault: "refused" }, { type: "work" },
    { type: "setFault", fault: "refused" }, { type: "work" },
    { type: "setFault", fault: "refused" }, { type: "work" });
  assert.equal(s.queue.length, 0);
  assert.equal(s.history[0].status, "dead");
  assert.equal(s.account.emails, 0);
});
