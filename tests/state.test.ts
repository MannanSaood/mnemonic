import { test } from "node:test";
import assert from "node:assert/strict";
import { flagProblem, init, lifeOf, machineProblem, step, type Action, type Ev, type State } from "../src/playgrounds/state/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const fire = (...evs: Ev[]): Action[] => evs.map((ev) => ({ type: "fire", ev }));

test("state: the happy path is identical in both designs", () => {
  const s = run(init(), ...fire("pay", "ship", "deliver"));
  assert.equal(s.machine.life, "delivered");
  assert.equal(lifeOf(s.flag.flags), "delivered");
  assert.deepEqual(s.flag.ledger, s.machine.ledger);
  assert.equal(flagProblem(s.flag), null);
  assert.equal(s.found.length, 0);
});

test("state: the flag order ships a refunded order; the state order refuses", () => {
  const s = run(init(), ...fire("pay", "cancel", "ship"));
  assert.ok(s.found.includes("ship-cancelled"));
  assert.equal(s.flag.ledger.parcels, 1);
  assert.equal(lifeOf(s.flag.flags), null, "paid + shipped + cancelled is not a real state");
  assert.ok(flagProblem(s.flag));
  assert.equal(s.machine.life, "cancelled");
  assert.equal(s.machine.ledger.parcels, 0);
  assert.equal(s.machine.rejected, 1);
  assert.equal(machineProblem(s.machine), null);
});

test("state: a resent cancel webhook refunds twice in the flag order only", () => {
  const s = run(init(), ...fire("pay", "cancel"), { type: "resend" });
  assert.ok(s.found.includes("refund-twice"));
  assert.equal(s.flag.ledger.refunded, 160);
  assert.equal(s.machine.ledger.refunded, 80);
  assert.equal(s.log[0].resent, true);
});

test("state: cancel then pay charges a cancelled order, and the flags still look legal", () => {
  const s = run(init(), ...fire("cancel", "pay"));
  assert.ok(s.found.includes("charge-cancelled"));
  assert.equal(lifeOf(s.flag.flags), "cancelled", "the combination looks fine; only the history was wrong");
  assert.ok(flagProblem(s.flag), "but the books show the money was kept");
  assert.equal(s.machine.ledger.charged, 0);
});

test("state: a resent ship sends two parcels in the flag order only", () => {
  const s = run(init(), ...fire("pay", "ship"), { type: "resend" });
  assert.ok(s.found.includes("ship-twice"));
  assert.equal(s.flag.ledger.parcels, 2);
  assert.equal(s.machine.ledger.parcels, 1);
});

test("state: the stress test corrupts flag orders and never state orders", () => {
  const s = run(init(), { type: "stress" });
  assert.ok(s.stress);
  assert.ok(s.stress.flagBad > 0);
  assert.equal(s.stress.machineBad, 0);
  assert.ok(s.stress.machineRejected > 0);
  const again = run(s, { type: "stress" });
  assert.equal(again.stress?.runs, 2);
});

test("state: new order keeps the challenges found; reset clears them", () => {
  let s = run(init(), ...fire("pay", "cancel", "ship"), { type: "newOrder" });
  assert.equal(s.machine.life, "pending");
  assert.equal(s.found.length, 1);
  s = run(s, { type: "reset" });
  assert.equal(s.found.length, 0);
});
