import { test } from "node:test";
import assert from "node:assert/strict";
import { chargesFor, challengeDone, init, runBatch, step, tally, type Action, type State } from "../src/playgrounds/reliable-links-and-idempotency/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const policy = (p: "once" | "retry" | "key"): Action => ({ type: "setPolicy", policy: p });

test("links: a clean round trip charges once and the customer sees paid", () => {
  const s = run(init(), { type: "pay" }, { type: "deliver" }, { type: "deliver" });
  assert.equal(s.ledger.length, 1);
  assert.equal(s.payments[0].outcome, "paid");
  assert.equal(s.messages, 2);
});

test("links: a dropped request is safe to retry, nothing was charged", () => {
  const s = run(init(), { type: "pay" }, { type: "drop" }, { type: "timer" }, { type: "deliver" }, { type: "deliver" });
  assert.equal(chargesFor(s, 1), 1);
  assert.equal(s.payments[0].attempts, 2);
});

test("links: retrying after a dropped response charges twice without a key", () => {
  const s = run(init(), { type: "pay" }, { type: "deliver" }, { type: "drop" }, { type: "timer" }, { type: "deliver" }, { type: "deliver" });
  assert.equal(chargesFor(s, 1), 2);
  assert.ok(challengeDone(s, "doubled"));
  assert.equal(tally(s).doubled, 1);
});

test("links: without retries a dropped response takes the money and shows an error", () => {
  const s = run(init(), policy("once"), { type: "pay" }, { type: "deliver" }, { type: "drop" }, { type: "timer" });
  assert.equal(s.payments[0].outcome, "error");
  assert.equal(chargesFor(s, 1), 1);
  assert.ok(challengeDone(s, "silent"));
  assert.equal(tally(s).chargedButError, 1);
});

test("links: with an idempotency key, lost responses never charge twice", () => {
  const s = run(init(), policy("key"), { type: "pay" },
    { type: "deliver" }, { type: "drop" }, { type: "timer" },
    { type: "deliver" }, { type: "drop" }, { type: "timer" },
    { type: "deliver" }, { type: "deliver" });
  assert.equal(chargesFor(s, 1), 1);
  assert.equal(s.payments[0].outcome, "paid");
  assert.ok(challengeDone(s, "keyed"));
});

test("links: a key saved outside the charge's transaction fails when the service crashes between them", () => {
  const s = run(init(), policy("key"), { type: "setAtomic", atomic: false }, { type: "pay" },
    { type: "crash" }, { type: "timer" }, { type: "deliver" }, { type: "deliver" });
  assert.equal(chargesFor(s, 1), 2);
  assert.ok(challengeDone(s, "broken"));
});

test("links: with the key in the same transaction, the crash cannot split them", () => {
  const s = run(init(), policy("key"), { type: "pay" }, { type: "crash" }, { type: "timer" }, { type: "deliver" }, { type: "deliver" });
  assert.equal(chargesFor(s, 1), 1);
  assert.ok(!challengeDone(s, "broken"));
});

test("links: the client gives up after the attempt limit", () => {
  let s = run(init(), { type: "pay" });
  for (let i = 0; i < 4; i++) s = run(s, { type: "drop" }, { type: "timer" });
  assert.equal(s.phase, "gaveup");
  assert.equal(s.payments[0].outcome, "error");
  assert.equal(s.payments[0].attempts, 4);
});

test("links: the policy cannot change while a payment is in flight", () => {
  const s = run(init(), { type: "pay" }, policy("key"));
  assert.equal(s.policy, "retry");
});

test("links: on a lossy link, only the keyed policy charges everyone exactly once", () => {
  const b = runBatch(0.2, 100);
  const [once, retry, key] = b.stats;
  assert.ok(once.unpaid > 0 && once.chargedButError > 0, "no retries loses payments and confuses customers");
  assert.ok(retry.doubled > 0, "plain retries double-charge");
  assert.equal(retry.unpaid, 0);
  assert.equal(key.doubled, 0);
  assert.equal(key.exactlyOnce, 100);
  assert.ok(key.messages > once.messages, "safety costs extra messages");
});

test("links: a perfect link makes every policy look correct", () => {
  const b = runBatch(0, 100);
  for (const st of b.stats) assert.equal(st.exactlyOnce, 100);
});
