import { test } from "node:test";
import assert from "node:assert/strict";
import { DECISIONS, GOOD, NAIVE, acmeAmount, acmeCharges, init, simulate, step, type Action, type Adapter, type State } from "../src/playgrounds/adapter/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const byId = (a: Adapter, id: string) => simulate(a).outcomes.find((o) => o.call.id === id)!;

test("adapter: the rename-only adapter charges ¥12 for a ¥1,250 order and 10x for KWD", () => {
  assert.equal(byId(NAIVE, "J-2002").charged, 12);
  assert.equal(byId(NAIVE, "K-3003").charged, 125000);
  assert.equal(byId(NAIVE, "A-1001").charged, 1250, "EUR, the currency in the vendor's docs, works");
  const m = simulate(NAIVE).metrics;
  assert.equal(m.checksPassed, 1);
  assert.equal(m.wrongAmounts, 2);
});

test("adapter: converting by the currency's minor unit fixes JPY and KWD", () => {
  const a: Adapter = { ...NAIVE, amount: "exponent" };
  assert.equal(acmeAmount(a, byId(a, "J-2002").call), "1250");
  assert.equal(acmeAmount(a, byId(a, "K-3003").call), "12.500");
  assert.equal(acmeCharges("12.500", "KWD"), 12500);
  assert.equal(simulate(a).metrics.wrongAmounts, 0);
});

test("adapter: unmapped result codes tell a declined customer that payments are down", () => {
  assert.match(byId(NAIVE, "A-1004").customerSaw, /unavailable/);
  assert.match(byId({ ...NAIVE, status: "mapped" }, "A-1004").customerSaw, /declined/);
});

test("adapter: a timeout after charging double-charges unless the adapter adds idempotency", () => {
  // raw error: the customer sees a 500 and pays again
  assert.equal(byId(NAIVE, "A-1005").chargeCount, 2);
  assert.match(byId(NAIVE, "A-1005").customerSaw, /500/);
  // wrapping the error alone hides the 500 but our retry still charges twice
  const wrapped = byId({ ...NAIVE, errors: "wrapped" }, "A-1005");
  assert.equal(wrapped.chargeCount, 2);
  assert.doesNotMatch(wrapped.customerSaw, /500/);
  // lookup by merchant_ref makes the retry safe
  assert.equal(byId({ ...NAIVE, errors: "wrapped", retry: "lookup" }, "A-1005").chargeCount, 1);
});

test("adapter: each decision fixes its own checks, and the full adapter passes all six", () => {
  const m = simulate(GOOD).metrics;
  assert.equal(m.checksPassed, 6);
  assert.equal(m.checksTotal, 6);
  assert.deepEqual([m.wrongAmounts, m.doubleCharges, m.errors500, m.misleading], [0, 0, 0, 0]);
});

test("adapter: the guided path records fixes, and callers are never edited", () => {
  let s = run(init(), { type: "guess", guess: "under" }, { type: "run" });
  assert.equal(s.first!.metrics.checksPassed, 1);
  for (const d of DECISIONS) s = run(s, { type: "set", decision: d, value: GOOD[d] });
  assert.equal(s.run!.metrics.checksPassed, 6);
  assert.deepEqual(s.fixes, DECISIONS);
  assert.equal(s.callerEdits, 0);
  assert.equal(s.guess, "under");
});
