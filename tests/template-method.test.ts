import { test } from "node:test";
import assert from "node:assert/strict";
import { drift, evaluate, init, step, totals, type Action, type State } from "../src/playgrounds/template-method/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const month = (s: State, ...actions: Action[]) => run(s, ...actions, { type: "run" }, { type: "next" });
const last = (s: State) => s.results[s.results.length - 1];

test("template-method: a fix made where the bug was reported reaches one copy, but every templated importer", () => {
  const s = run(init(), { type: "patch", design: "copied", imp: "csv" }, { type: "patch", design: "template" }, { type: "run" });
  const r = last(s);
  assert.deepEqual(r.copied.problems.map((p) => p.imp), ["json", "bank"]);
  assert.equal(r.template.problems.length, 0);
  assert.equal(r.copied.edits, 1);
  assert.equal(r.template.edits, 1);
  assert.ok(drift(s) > 0, "the copies now disagree");
});

test("template-method: fixing every copy works, at three edits against one", () => {
  const s = run(init(), ...(["csv", "json", "bank"] as const).map((imp) => ({ type: "patch", design: "copied", imp }) as Action), { type: "patch", design: "template" }, { type: "run" });
  assert.equal(last(s).copied.problems.length, 0);
  assert.equal(last(s).copied.edits, 3);
  assert.equal(last(s).template.edits, 1);
  assert.equal(drift(s), 0);
});

test("template-method: a check only one importer needs is cheaper in the copy, and an override without a hook call never runs", () => {
  let s = init();
  for (let k = 0; k < 3; k++) {
    s = month(s, ...(["csv", "json", "bank"] as const).map((imp) => ({ type: "patch", design: "copied", imp }) as Action), { type: "patch", design: "template" });
  }
  assert.equal(s.ticket, 3);
  // Break it: override in Bank, forget the hook call in the base.
  const broken = run(s, { type: "addCheck" }, { type: "overrideBank" });
  const bad = evaluate(broken, "template", 3);
  assert.equal(bad.length, 1);
  assert.match(bad[0].text, /never calls it/);
  assert.equal(evaluate(broken, "copied", 3).length, 0);
  // Do it right: hook call + override.
  s = run(broken, { type: "addHook" }, { type: "run" });
  assert.equal(last(s).copied.edits, 1);
  assert.equal(last(s).template.edits, 2);
  assert.equal(last(s).template.problems.length, 0);
});

test("template-method: a new importer copied from Bank inherits its drift and its balance check", () => {
  let s = init();
  // Fix each ticket only where it was reported, as tickets usually are.
  s = month(s, { type: "patch", design: "copied", imp: "csv" }, { type: "patch", design: "template" });
  s = month(s, { type: "patch", design: "copied", imp: "json" }, { type: "patch", design: "template" });
  s = month(s, { type: "patch", design: "copied", imp: "bank" }, { type: "patch", design: "template" });
  s = month(s, { type: "addCheck" }, { type: "addHook" }, { type: "overrideBank" });
  s = run(s, { type: "copyFrom", src: "bank" }, { type: "writeParse" }, { type: "run" });
  const r = last(s);
  const stripe = r.copied.problems.filter((p) => p.imp === "stripe").map((p) => p.text).join(" | ");
  assert.match(stripe, /duplicate/);
  assert.match(stripe, /cents/);
  assert.match(stripe, /rejected every payout/);
  assert.equal(r.template.problems.length, 0, "the templated Stripe importer gets every shared fix");
  assert.equal(r.template.edits, 1);
  const t = totals(s);
  assert.ok(t.copied.problems > t.template.problems);
});

test("template-method: skipping the new importer leaves payouts unposted in both designs", () => {
  let s = init();
  for (let k = 0; k < 4; k++) s = run(s, { type: "run" }, { type: "next" });
  s = run(s, { type: "run" });
  assert.ok(last(s).copied.problems.some((p) => p.imp === "stripe" && /never posted/.test(p.text)));
  assert.ok(last(s).template.problems.some((p) => p.imp === "stripe" && /never posted/.test(p.text)));
});
