import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TABLE, PRESETS, builtIds, evaluate, frames, init, parse, printTop, step, type Action, type Row, type State } from "../src/playgrounds/pratt-parsing/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const tree = (src: string, table: Row[] = DEFAULT_TABLE) => { const r = parse(src, table); assert.ok(r.tree, r.error ?? ""); return printTop(r.tree!); };
const withBp = (key: string, bp: number) => DEFAULT_TABLE.map((r) => (r.key === key ? { ...r, bp } : r));

test("pratt: the higher binding power grabs the operand between two operators", () => {
  assert.equal(tree(PRESETS[0].src), '(cpu > 0.95) or ((mem > 0.9) and (env == "prod"))');
  assert.equal(tree("a or b and c"), "a or (b and c)");
  assert.equal(tree("a or b and c", withBp("and", 1)), "(a or b) and c");
  assert.equal(tree("a or b and c", withBp("or", 3)), "(a or b) and c");
});

test("pratt: arithmetic needs no new code, only rows in the table", () => {
  assert.equal(tree(PRESETS[1].src), '((errors / requests) > 0.05) and (not (env == "dev"))');
  assert.equal(tree("a + b * c - d"), "(a + (b * c)) - d");
});

test("pratt: equal powers stop the inner loop (left-assoc); bp - 1 keeps going (right-assoc)", () => {
  assert.equal(tree(PRESETS[2].src), "(requests - retries) - timeouts");
  const right = DEFAULT_TABLE.map((r) => (r.key === "add" ? { ...r, assoc: "right" as const } : r));
  assert.equal(tree(PRESETS[2].src, right), "requests - (retries - timeouts)");
  assert.equal(evaluate(parse(PRESETS[2].src).tree!).value, 390);
  assert.equal(evaluate(parse(PRESETS[2].src, right).tree!).value, 398);
});

test("pratt: prefix operators and parentheses", () => {
  assert.equal(tree(PRESETS[3].src), '((-p99) < (-200)) or (((cpu > 0.9) or (mem > 0.9)) and (env == "prod"))');
  assert.equal(tree("not cpu > 0.9 and up"), "(not (cpu > 0.9)) and up");
});

test("pratt: errors are reported with positions", () => {
  assert.match(parse("cpu > ").error!, /expected an operand/);
  assert.match(parse("cpu 0.9").error!, /1:5: expected an operator/);
  assert.match(parse('env == "prod').error!, /unterminated string/);
  assert.match(parse("(cpu > 1").error!, /expected '\)'/);
});

test("pratt: the trace opens and closes frames and builds every node", () => {
  const r = parse(PRESETS[0].src);
  assert.deepEqual(frames(r.events, r.events.length), []);
  assert.equal(r.events.filter((e) => e.type === "call").length, r.events.filter((e) => e.type === "return").length);
  assert.equal(builtIds(r.events, r.events.length).size, 11);
  const decideAnd = r.events.find((e) => e.type === "decide" && e.op === "and" && e.bind);
  assert.ok(decideAnd && decideAnd.type === "decide" && decideAnd.bind && decideAnd.minBp === 1);
});

test("pratt: the staging host pages by default; one number makes it silent (flip goal)", () => {
  let s = init();
  assert.equal(evaluate(parse(s.src, s.table).tree!).value, true);
  s = run(s, { type: "bp", key: "and", delta: -1 });
  assert.equal(evaluate(parse(s.src, s.table).tree!).value, false);
  assert.equal(s.goals.flip, true);
  assert.equal(s.flips, 1);
  assert.equal(s.trees[s.src].length, 2);
});

test("pratt: comparison below and parses but cannot be evaluated (broken goal)", () => {
  const s = run(init(), { type: "bp", key: "cmp", delta: -1 }, { type: "bp", key: "cmp", delta: -1 }, { type: "bp", key: "cmp", delta: -1 });
  const r = parse(s.src, s.table);
  assert.ok(r.tree);
  assert.match(evaluate(r.tree!).error!, /needs/);
  assert.equal(s.goals.broken, true);
});

test("pratt: associativity goal, stepping and reset", () => {
  let s = run(init(), { type: "preset", index: 2 }, { type: "assoc", key: "add" });
  assert.equal(s.goals.assoc, true);
  s = run(s, { type: "step" }, { type: "step" });
  assert.equal(s.shown, 2);
  s = run(s, { type: "run" });
  assert.equal(s.shown, parse(s.src, s.table).events.length);
  s = run(s, { type: "reset" });
  assert.equal(s.edits, 0);
  assert.equal(s.table[1].bp, 2);
});
