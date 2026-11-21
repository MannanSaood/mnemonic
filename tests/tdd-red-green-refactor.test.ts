import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY, TESTS, TEST_IDS, challenges, codeLines, init, runSuite, step, summary, total,
  type Action, type Lang, type State,
} from "../src/playgrounds/tdd-red-green-refactor/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const w = (test: string) => ({ type: "write", test }) as Action;
const g = (move: string) => ({ type: "green", move }) as Action;
const r = (move: string) => ({ type: "refactor", move }) as Action;
const next: Action = { type: "doneRefactoring" };

/** The small-steps path: fake it, remove duplication, then one small change per test. */
const smallPath = (): State => run(init(),
  w("t1"), g("zero"), next,
  w("t2"), g("const"), r("dup"), next,
  w("t3"), next, // already passes: the refactoring generalised the code
  w("t4"), g("ge"), r("name"), next,
  w("t5"), g("minus5"), r("extract"), next,
  w("t6"), g("floor"), next);

test("tdd: a new test goes red first, and the smallest change turns it green", () => {
  let s = run(init(), w("t1"));
  assert.equal(s.phase, "red");
  assert.equal(s.bars.at(-1)!.kind, "red");
  s = run(s, g("zero"));
  assert.equal(s.phase, "refactor");
  assert.equal(s.bars.at(-1)!.kind, "green");
  assert.equal(s.cycles, 1);
});

test("tdd: the small-steps path finishes with no surprises and no step over 5 lines", () => {
  const s = smallPath();
  assert.equal(s.phase, "done");
  const sum = summary(s);
  assert.equal(sum.surprises, 0);
  assert.ok(sum.largestStep <= 5, `largest step ${sum.largestStep}`);
  assert.equal(sum.untested, 0);
  assert.ok(runSuite(s.impl, TEST_IDS).every((x) => x.pass));
  assert.ok(challenges(s).find((c) => c.id === "small")!.done);
  assert.ok(challenges(s).find((c) => c.id === "clean")!.done);
});

test("tdd: a big first step leaves untested code, later tests never go red, and the hidden bug surfaces", () => {
  let s = run(init(), w("t1"), g("leap"));
  assert.equal(s.phase, "refactor");
  assert.ok(summary(s).untested >= 6, "discount and coupon code with no test");
  assert.equal(s.largestStep, 9);
  s = run(s, next, w("t2"));
  assert.deepEqual(s.neverRed, ["t2"]);
  s = run(s, next, w("t4"));
  assert.equal(s.phase, "red", "the leap wrote > where the rule says >=");
  assert.match(s.note, /\$100\.00, want \$90\.00/);
});

test("tdd: reading the test wrong (over instead of from $100) is a surprise red, and undo restores", () => {
  let s = run(init(), w("t1"), g("zero"), next, w("t4"), g("gt"));
  assert.equal(s.phase, "broken");
  assert.equal(s.surprises, 1);
  assert.equal(s.bars.at(-1)!.kind, "surprise");
  s = run(s, { type: "undo" });
  assert.equal(s.phase, "red");
  assert.equal(s.impl.sum, "zero");
  s = run(s, g("ge"));
  assert.equal(s.phase, "refactor");
});

test("tdd: the tests catch a tidy-up that changes behaviour", () => {
  let s = run(init(), w("t4"), g("ge"));
  s = run(s, r("slip"));
  assert.equal(s.phase, "broken");
  assert.equal(s.slipsCaught, 1);
  assert.equal(s.bars.at(-1)!.kind, "caught");
  s = run(s, { type: "undo" });
  assert.equal(s.phase, "refactor");
  assert.equal(s.impl.discount, "ge");
});

test("tdd: the cart total rules and the generated code agree", () => {
  const full = { ...EMPTY, sum: "loop", discount: "ge", coupon: "floor" } as const;
  for (const id of TEST_IDS) assert.equal(total(full, TESTS[id]), TESTS[id].want, id);
  for (const lang of ["go", "python", "typescript", "rust"] as Lang[]) {
    const lines = codeLines({ ...full, named: true, extracted: true }, lang).join("\n");
    assert.match(lines, /SAVE5/);
    assert.match(lines, />= (BulkFromCents|BULK_FROM_CENTS)/);
  }
  assert.equal(total(EMPTY, TESTS.t1), null);
});

test("tdd: moves are ignored in the wrong phase; reset clears", () => {
  const s = run(init(), g("zero"), r("dup"), { type: "undo" });
  assert.deepEqual(s, init());
  assert.deepEqual(run(smallPath(), { type: "reset" }), init());
});
