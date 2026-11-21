import { test } from "node:test";
import assert from "node:assert/strict";
import { FUNCS, init, optionalOutcome, shapes, step, tally, unionErrors, unionOutcome, type Action, type State } from "../src/playgrounds/discriminated-unions/model.ts";

const go = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("discriminated-unions: adding requires_action flags 4 union switches and 0 optional-field functions", () => {
  const s = go(init(), { type: "predict", value: "fourZero" }, { type: "add" });
  assert.equal(unionErrors(s).length, 4);
  assert.ok(!unionErrors(s).includes("statusLabel"), "the default branch hides the new member");
  const t = tally(s);
  assert.equal(t.optionalWrong, 3, "three optional-field functions do the wrong thing, silently");
  assert.ok(s.done.includes("count"));
  assert.equal(go(s, { type: "predict", value: "zero" }).predict, "fourZero", "prediction locks after the change");
});

test("discriminated-unions: the union side cannot ship until every flagged switch is handled", () => {
  let s = go(init(), { type: "add" }, { type: "ship" });
  assert.deepEqual(s.shippedUnion, { errors: 4, wrong: 0 });
  assert.equal(unionOutcome(s, "readyToShip"), null, "a failed build deploys nothing");
  for (const f of unionErrors(s)) s = step(s, { type: "handle", f });
  s = go(s, { type: "ship" });
  assert.deepEqual(s.shippedUnion, { errors: 0, wrong: 1 }, "the default branch in statusLabel still ships a wrong label");
  s = go(s, { type: "ending", f: "statusLabel", ending: "never" });
  assert.deepEqual(unionErrors(s), ["statusLabel"]);
  assert.ok(s.done.includes("unflagged"));
  s = go(s, { type: "handle", f: "statusLabel" }, { type: "ship" });
  assert.deepEqual(s.shippedUnion, { errors: 0, wrong: 0 });
  assert.ok(s.done.includes("shipUnion"));
});

test("discriminated-unions: the optional side ships at once, ships unpaid goods, and needs every function read", () => {
  let s = go(init(), { type: "add" }, { type: "ship" });
  assert.equal(optionalOutcome(s, "readyToShip").ok, false);
  assert.match(optionalOutcome(s, "readyToShip").text, /ships an order nobody has paid for/);
  s = go(s, { type: "fix", f: "readyToShip" });
  assert.ok(!s.fixed.includes("readyToShip"), "you must read a function before you can fix it");
  for (const f of FUNCS) s = step(s, { type: "audit", f });
  for (const f of ["readyToShip", "statusLabel", "receiptLine"] as const) s = step(s, { type: "fix", f });
  s = go(s, { type: "ship" });
  const t = tally(s);
  assert.equal(t.optionalWrong, 0);
  assert.equal(t.read, 5);
  assert.ok(s.done.includes("shipOptional"));
});

test("discriminated-unions: default branches everywhere silence the compiler and wrong outcomes ship", () => {
  let s = init();
  for (const f of FUNCS) s = step(s, { type: "ending", f, ending: "default" });
  s = go(s, { type: "add" });
  assert.equal(unionErrors(s).length, 0);
  s = go(s, { type: "ship" });
  assert.equal(s.shippedUnion!.wrong, 2);
  assert.ok(s.done.includes("silence"));
});

test("discriminated-unions: state space, 5 to 6 union members versus 16 to 32 field combinations", () => {
  assert.deepEqual(shapes(init()), { union: 5, optional: 16 });
  assert.deepEqual(shapes(go(init(), { type: "add" })), { union: 6, optional: 32 });
  assert.deepEqual(go(init(), { type: "handle", f: "readyToShip" }), init(), "nothing to handle before the change");
  assert.deepEqual(go(init(), { type: "add" }, { type: "reset" }), init());
});
