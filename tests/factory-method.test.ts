import { test } from "node:test";
import assert from "node:assert/strict";
import { CORRUPT_NIGHT, FIX_NIGHT, NIGHTS, init, step, type Action, type State } from "../src/playgrounds/factory-method/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const summary = (s: State, a: string) => s.done.find((d) => d.approach === a)!;

test("factory-method: without a hook, overriding createWriter is not possible", () => {
  const s = run(init(), { type: "choose", approach: "override" });
  assert.equal(s.run, null);
});

test("factory-method: the PR path loses exports while it waits, then gets the fix", () => {
  const s = run(init(), { type: "choose", approach: "pr" }, { type: "finish" });
  const d = summary(s, "pr");
  assert.equal(d.missing, 5);
  assert.equal(d.corrupt, 0, "platform's fix is in place by the truncated night");
  assert.equal(d.delivered, NIGHTS - 5);
});

test("factory-method: a longer review means more nights without an export", () => {
  const s = run(init(), { type: "wait", days: 9 }, { type: "choose", approach: "pr" }, { type: "finish" });
  assert.equal(summary(s, "pr").missing, 9);
});

test("factory-method: the copied run() ships at once but misses the fix and sends a broken file", () => {
  const s = run(init(), { type: "choose", approach: "fork" }, { type: "finish" });
  const d = summary(s, "fork");
  assert.equal(d.missing, 0);
  assert.equal(d.corrupt, 1);
  assert.ok(d.copied > 0);
  assert.equal(s.run!.nights[CORRUPT_NIGHT - 1].result, "corrupt");
});

test("factory-method: overriding the hook ships on night 1 and inherits the fix", () => {
  const s = run(init(), { type: "design", design: "hook" }, { type: "choose", approach: "override" }, { type: "finish" });
  const d = summary(s, "override");
  assert.equal(d.missing, 0);
  assert.equal(d.corrupt, 0);
  assert.equal(d.retried, 1);
  assert.equal(d.delivered, NIGHTS);
  assert.ok(s.run!.nights[FIX_NIGHT - 1].path.includes("checksum ✓"));
});

test("factory-method: nights step one at a time and the prediction is locked once made", () => {
  let s = run(init(), { type: "predict", approach: "fork" }, { type: "predict", approach: "override" });
  assert.equal(s.prediction, "fork");
  s = run(s, { type: "choose", approach: "pr" }, { type: "night" }, { type: "night" });
  assert.equal(s.run!.nights.length, 2);
  assert.equal(s.done.length, 0);
});
