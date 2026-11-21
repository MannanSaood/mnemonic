import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, cursor, finishKey, init, lex, splitWords, step, type Action, type State } from "../src/playgrounds/lexing-and-tokens/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const texts = (src: string, munch = true) => lex(src, { munch }).tokens.filter((t) => t.kind !== "eof").map((t) => `${t.kind}:${t.text}`);

test("lexing: the tested rule gives the same tokens as splitting on spaces", () => {
  const src = PRESETS[0].src;
  assert.deepEqual(texts(src), ["ident:cpu", "op:>", "number:0.9", "keyword:and", "ident:env", "op:==", 'string:"prod"']);
  assert.ok(splitWords(src, lex(src).tokens).every((w) => w.ok));
});

test("lexing: without spaces the scanner still finds 7 tokens, split() finds 4 words and 3 are wrong", () => {
  const src = PRESETS[1].src;
  assert.deepEqual(texts(src), ["ident:cpu", "op:>=", "number:0.9", "keyword:and", "ident:env", "op:==", 'string:"prod eu"']);
  const words = splitWords(src, lex(src).tokens);
  assert.equal(words.length, 4);
  assert.equal(words.filter((w) => !w.ok).length, 3);
});

test("lexing: longest match takes >= whole; turning it off leaves a stray = error", () => {
  assert.deepEqual(texts("cpu>=0.9"), ["ident:cpu", "op:>=", "number:0.9"]);
  const off = lex("cpu>=0.9", { munch: false });
  assert.deepEqual(off.tokens.map((t) => t.text), ["cpu", ">", "=", "0.9", ""]);
  assert.equal(off.errors.length, 1);
  assert.equal(off.errors[0].message, "'=' is not an operator; use ==");
  assert.ok(lex("cpu>=0.9").peeks > off.peeks, "longest match costs a peek");
});

test("lexing: an unterminated string stops at the end of the line, with a position, and scanning resumes", () => {
  const r = lex(PRESETS[2].src);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].message, "unterminated string");
  assert.equal(r.errors[0].text, '"prod');
  assert.deepEqual([r.errors[0].line, r.errors[0].col], [1, 8]);
  const after = r.tokens.filter((t) => t.line === 2 && t.kind !== "eof").map((t) => t.text);
  assert.deepEqual(after, ["and", "cpu", ">", "0.9"]);
});

test("lexing: comments and whitespace are skipped, bad characters become error tokens", () => {
  assert.deepEqual(texts(PRESETS[3].src), ["ident:errors", "op:/", "ident:requests", "op:>=", "number:0.05", "keyword:and", "ident:env", "op:!=", 'string:"dev"']);
  const bad = lex(PRESETS[4].src);
  assert.equal(bad.errors[0].message, "unexpected character '@'");
  assert.equal(bad.tokens.at(-2)!.text, "90", "scanning went on after the bad character");
});

test("lexing: stepping reveals tokens one at a time, moves the cursor and reveals the prediction", () => {
  let s = init();
  assert.equal(s.src, PRESETS[1].src);
  s = run(s, { type: "step" }, { type: "step" });
  assert.equal(s.shown, 2);
  assert.deepEqual(cursor(s), { start: 3, current: 5 });
  assert.equal(s.goals.munch, true);
  s = run(s, { type: "run" });
  assert.equal(s.shown, 8);
  assert.ok(s.finished.includes(finishKey(PRESETS[1].src, true)));
  assert.equal(run(s, { type: "step" }), run(s, { type: "step" }), "step at the end is a no-op");
});

test("lexing: the guided challenges complete", () => {
  let s = run(init(), { type: "munch" }, { type: "run" });
  assert.equal(s.goals.broken, true);
  s = run(s, { type: "munch" }, { type: "preset", index: 2 }, { type: "run" });
  assert.equal(s.goals.recover, true);
  s = run(s, { type: "reset" });
  assert.deepEqual(s.goals, { munch: false, broken: false, recover: false });
});
