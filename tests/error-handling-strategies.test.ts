import { test } from "node:test";
import assert from "node:assert/strict";
import { START, init, runAll, score, simulate, step, type Action, type Policies, type State } from "../src/playgrounds/error-handling-strategies/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const GOOD: Policies = { handler: "message", service: "wrap", payment: "retry", repo: "retry" };
const pass = (p: Policies) => runAll(p).every((r) => { const s = score(r.verdict); return s.passed === s.total; });

test("errors: one layer that logs and continues ships an unpaid order and tells the customer it worked", () => {
  const r = simulate(START, "down");
  assert.equal(r.status, 201);
  assert.equal(r.charges, 0);
  assert.equal(r.saves, 1);
  assert.equal(r.verdict.honest, false);
  assert.equal(r.verdict.moneyRight, false);
  assert.equal(r.verdict.causeLogged, true, "the cause is logged, but nobody acted on it");
});

test("errors: wrap below and translate at the edge gives an honest 503 with the cause in one log line", () => {
  const r = simulate({ ...START, payment: "wrap" }, "down");
  assert.equal(r.status, 503);
  assert.equal(r.saves, 0);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /place order 1042: charge order 1042: POST \/v1\/charges: 503/);
  assert.equal(score(r.verdict).passed, score(r.verdict).total);
});

test("errors: a declined card is not retried and becomes a 402", () => {
  const r = simulate(GOOD, "declined");
  assert.equal(r.apiCalls, 1);
  assert.equal(r.status, 402);
});

test("errors: retrying next to the call absorbs a blip, charged once", () => {
  const r = simulate(GOOD, "blip");
  assert.equal(r.status, 201);
  assert.equal(r.apiCalls, 2);
  assert.equal(r.charges, 1);
  assert.equal(r.verdict.recovered, true);
});

test("errors: retrying the whole order after a DB timeout charges the card twice", () => {
  const r = simulate({ ...GOOD, repo: "wrap", service: "retry" }, "dbTimeout");
  assert.equal(r.charges, 2);
  assert.equal(r.saves, 1);
  assert.equal(r.verdict.moneyRight, false);
  const ok = simulate(GOOD, "dbTimeout");
  assert.equal(ok.charges, 1);
  assert.equal(ok.verdict.moneyRight, true);
});

test("errors: converting to a user message deep down loses the root cause", () => {
  const r = simulate({ ...GOOD, payment: "message" }, "down");
  assert.equal(r.verdict.causeLogged, false);
  assert.equal(r.status, 500);
});

test("errors: passing the raw error to the customer leaks internals and logs nothing", () => {
  const r = simulate({ ...GOOD, handler: "wrap" }, "declined");
  assert.equal(r.status, 500);
  assert.match(r.shown, /402 card_declined/);
  assert.equal(r.verdict.causeLogged, false);
});

test("errors: the good policy set passes every fault; the starting one does not", () => {
  assert.ok(pass(GOOD));
  assert.ok(!pass(START));
  const s = run(init(), { type: "policy", layer: "payment", policy: "retry" }, { type: "policy", layer: "repo", policy: "retry" }, { type: "runAll" });
  assert.ok(s.goals.includes("allPass"));
  assert.ok(s.goals.includes("absorbBlip"));
});

test("errors: changing a policy re-runs the last fault", () => {
  let s = run(init(), { type: "inject", fault: "down" });
  assert.equal(s.last!.status, 201);
  s = run(s, { type: "policy", layer: "payment", policy: "wrap" });
  assert.equal(s.last!.status, 503);
  assert.ok(s.goals.includes("honestOutage"));
});
