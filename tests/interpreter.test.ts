import { test } from "node:test";
import assert from "node:assert/strict";
import { USERS, check, cost, evaluate, init, initialRule, matches, print, step, type Action, type State } from "../src/playgrounds/interpreter/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const user = (name: string) => USERS.find((u) => u.name === name)!;

test("interpreter: the starting rule prints, checks clean, and matches three users", () => {
  const r = initialRule();
  assert.equal(print(r), "country in [DE, FR] and (plan = pro or seats >= 50) and not optOut");
  assert.deepEqual(check(r), []);
  assert.deepEqual(matches(r), ["Lena", "Marc", "Chloé"]);
});

test("interpreter: for Sam (US) AND stops after the country check: 2 of 7 nodes run", () => {
  const e = evaluate(initialRule(), user("Sam"));
  assert.equal(e.value, false);
  assert.equal(e.evaluated, 2);
  assert.equal(e.marks[3], "skipped");
  assert.ok(cost(initialRule()).lazy < cost(initialRule()).eager);
});

test("interpreter: the targeting tasks are data edits, no code", () => {
  let s = run(init(), { type: "cycle", id: 2 });
  assert.deepEqual(matches(s.rule).sort(), ["Aiko", "Chloé", "Lena", "Marc", "Yuki"]);
  assert.equal(s.done[0], true);
  s = run(s, { type: "nextTask" }, { type: "flip", id: 3 });
  assert.equal(s.done[1], true);
  assert.deepEqual(matches(s.rule).sort(), ["Aiko", "Chloé"]);
  s = run(s, { type: "save" });
  assert.equal(s.saves, 1);
  assert.equal(s.edits, 2);
});

test("interpreter: comparing text with >= fails at runtime only for some users, and the checker refuses to save it", () => {
  const s = run(init(), { type: "attr", id: 5 });
  assert.equal(evaluate(s.rule, user("Lena")).value, true, "Lena is pro, so OR never reaches the bad node");
  assert.equal(evaluate(s.rule, user("Marc")).value, "error");
  assert.equal(check(s.rule).length, 1);
  const saved = run(s, { type: "save" });
  assert.equal(saved.saves, 0);
  assert.equal(saved.rejected, 1);
  assert.equal(saved.saved, s.saved, "the live rule did not change");
});

test("interpreter: negate wraps and unwraps a node", () => {
  let s = run(init(), { type: "negate", id: 2 });
  assert.match(print(s.rule), /^not country in/);
  s = run(s, { type: "negate", id: 8 });
  assert.equal(print(s.rule), print(initialRule()));
});
