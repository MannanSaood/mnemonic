import { test } from "node:test";
import assert from "node:assert/strict";
import { BEST, FIELDS, combos, goals, init, memory, step, type Action, type Field, type State } from "../src/playgrounds/flyweight/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const share = (s: State, fs: Field[]) => run(s, ...fs.map((field) => ({ type: "toggle", field }) as Action));

test("flyweight: sharing the six repeating fields cuts 10M lines to about a third (the predict answer)", () => {
  const m = memory(BEST, 10_000_000);
  assert.ok(m.naive > 3e9 && m.naive < 3.3e9);
  assert.ok(m.total > 0.9e9 && m.total < 1.1e9, `about 1 GB, got ${m.total}`);
  assert.equal(m.poolObjects, 40 * 15 * 8 * 3);
  assert.ok(m.pool < m.total / 100, "the shared pool itself is tiny; the per-line fields dominate");
});

test("flyweight: BEST is the cheapest split of all 512", () => {
  const best = memory(BEST, 10_000_000).total;
  for (let mask = 0; mask < 1 << FIELDS.length; mask++) {
    const fs = FIELDS.filter((_, i) => mask & (1 << i));
    assert.ok(memory(fs, 10_000_000).total >= best, fs.join(","));
  }
});

test("flyweight: sharing a per-line field makes the pool one entry per line and costs more than no sharing", () => {
  for (const f of ["timestamp", "args"] as Field[]) {
    const m = memory([...BEST, f], 10_000_000);
    assert.equal(m.poolObjects, 10_000_000);
    assert.ok(m.total > m.naive);
  }
  assert.ok(memory([...BEST, "traceId"], 10_000_000).total > memory([], 10_000_000).total);
});

test("flyweight: at 10k lines the same split barely helps, because most combinations appear only once", () => {
  const small = memory(BEST, 10_000);
  assert.ok(small.total / small.naive > 0.9);
  assert.ok(combos(BEST, 10_000) > 5_000);
});

test("flyweight: editing one line's shared level edits hundreds of lines", () => {
  let s = run(share(init(), BEST), { type: "editLine" });
  assert.ok(s.edit!.changed > 100);
  s = run(init(), { type: "editLine" });
  assert.equal(s.edit!.changed, 1);
});

test("flyweight: goals follow the reader's measurements", () => {
  let s = run(share(init(), BEST), { type: "measure" }, { type: "editLine" });
  assert.equal(goals(s).mutated, true);
  assert.equal(goals(s).third, true);
  assert.equal(goals(s).best, true);
  s = run(share(s, ["timestamp"]), { type: "measure" }, { type: "editLine" });
  assert.equal(goals(s).worse, true);
  assert.equal(s.edit!.changed, 1, "with a per-line field shared, every line has its own object again");
  assert.deepEqual(run(s, { type: "reset" }), init());
});
