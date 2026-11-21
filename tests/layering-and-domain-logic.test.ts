import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTRIES, RULES, challengeDone, crossover, idealCurve, init, predictRevealed, price, pricesOf, step, totals, wrongAt,
  type Action, type Place, type State, type Style,
} from "../src/playgrounds/layering-and-domain-logic/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const style = (x: Style): Action => ({ type: "style", style: x });
/** Write the next rule into these places and ship it. */
const ship = (...ps: Place[]): Action[] => [...ps.map((p): Action => ({ type: "place", place: p })), { type: "ship" }];
const everywhere: Place[] = [...ENTRIES];

test("layering: the pricing function applies the five rules to the sample cart", () => {
  assert.equal(price([]), 185_00);
  assert.equal(price(["over100"]), 166_50);
  assert.equal(price(["over100", "coupon", "gold"]), 147_25);
  assert.equal(price(["over100", "coupon", "gold", "giftcards"]), 154_75);
  assert.equal(price(["over100", "coupon", "gold", "giftcards", "cap"]), 158_00);
});

test("layering: a rule written into one script makes the screens disagree", () => {
  const s = run(init(), ...ship("checkout"));
  const p = pricesOf("script", s.code.script);
  assert.equal(p.checkout, 166_50);
  assert.equal(p.preview, 185_00);
  assert.deepEqual(wrongAt("script", s.code.script), ["preview", "reorder", "invoice"]);
  assert.ok(challengeDone(s, "drift"));
});

test("layering: scripts done right cost four edits per rule, and interacting rules grow in every copy", () => {
  let s = init();
  for (let i = 0; i < RULES.length; i++) s = run(s, ...ship(...everywhere));
  const c = s.code.script;
  assert.equal(wrongAt("script", c).length, 0);
  assert.equal(totals("script", c).edits, 20);
  assert.equal(totals("script", c).lines, idealCurve("script")[5]);
  assert.equal(c.shipped[3].lines, 4 * (3 + 3), "the gift-card exclusion reworks the three rules in each script");
  assert.ok(challengeDone(s, "scriptsAll"));
});

test("layering: the domain model is one edit per rule and every screen agrees", () => {
  let s = run(init(), style("domain"));
  for (let i = 0; i < RULES.length; i++) s = run(s, ...ship("shared"));
  const c = s.code.domain;
  assert.equal(wrongAt("domain", c).length, 0);
  assert.equal(totals("domain", c).edits, 5);
  assert.ok(challengeDone(s, "domainAll"));
});

test("layering: the domain model overtakes scripts at rule 4 (the predicted answer)", () => {
  assert.equal(crossover(), 4);
  const sc = idealCurve("script"), dm = idealCurve("domain");
  assert.ok(sc[3] < dm[3], "scripts still cheaper after three rules");
  assert.ok(dm[4] < sc[4]);
  let s = run(init(), { type: "predict", value: "4" });
  for (let i = 0; i < 3; i++) s = run(s, ...ship(...everywhere));
  assert.ok(!predictRevealed(s));
  s = run(s, ...ship(...everywhere));
  assert.ok(predictRevealed(s));
});

test("layering: a rule placed in a script under the domain model drifts too (the anemic trap)", () => {
  const s = run(init(), style("domain"), ...ship("checkout"));
  assert.deepEqual(wrongAt("domain", s.code.domain), ["preview", "reorder", "invoice"]);
});

test("layering: in the database the cart preview cannot reach the SQL function", () => {
  let s = run(init(), style("db"), ...ship("shared"));
  assert.deepEqual(wrongAt("db", s.code.db), ["preview"]);
  assert.ok(challengeDone(s, "dbGap"));
  s = run(s, { type: "undoStyle" }, ...ship("shared", "preview"));
  assert.equal(wrongAt("db", s.code.db).length, 0);
  const t = totals("db", s.code.db);
  assert.equal(t.migrations, 1);
  assert.equal(t.dbTests, 1);
});

test("layering: shipping needs at least one place, and nothing ships after the fifth rule", () => {
  let s = run(init(), { type: "ship" });
  assert.equal(s.code.script.shipped.length, 0);
  for (let i = 0; i < RULES.length + 1; i++) s = run(s, ...ship("checkout"));
  assert.equal(s.code.script.shipped.length, RULES.length);
});

test("layering: each style keeps its own codebase; reset clears all", () => {
  let s = run(init(), ...ship("checkout"), style("domain"), ...ship("shared"));
  assert.equal(s.code.script.shipped.length, 1);
  assert.equal(s.code.domain.shipped.length, 1);
  s = run(s, { type: "reset" });
  assert.deepEqual(s, init());
});
