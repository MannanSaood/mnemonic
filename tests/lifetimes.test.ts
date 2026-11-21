import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, allowed, init, outcome, stats, step, verdict, type Action, type State } from "../src/playgrounds/lifetimes/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("lifetimes: the starting layout is rejected although this request returns the config default", () => {
  const s = init();
  assert.equal(ANSWER, "no");
  assert.equal(s.header, false);
  const v = verdict(s);
  assert.equal(v.ok, false);
  assert.equal(v.code, "E0505");
  assert.equal(v.at, 4);
  assert.deepEqual(v.notes.map((n) => n.at), [3, 4, 5]);
  assert.equal(outcome(s).kind, "luck");
  assert.deepEqual(allowed(s), { from: 3, to: 4 }, "'a ends at drop(head)");
  // challenges only count what the reader did
  assert.deepEqual(s.done, []);
});

test("lifetimes: with the header, the rejected layout would read freed memory", () => {
  const s = run(init(), { type: "guess", guess: "no" }, { type: "header", on: true }, { type: "unchecked", on: true });
  const o = outcome(s);
  assert.equal(o.kind, "dangling");
  assert.deepEqual(o.rows, [5, 6, 7]);
  assert.ok(s.done.includes("dangle"));
  assert.equal(s.guess, "no");
});

test("lifetimes: moving drop(head) down or the last use up makes it compile; annotations change nothing", () => {
  const a = run(init(), { type: "drop", row: 7 });
  assert.equal(verdict(a).ok, true);
  assert.ok(a.done.includes("fit"));
  const b = run(init(), { type: "lastUse", row: 4 });
  assert.equal(verdict(b).ok, true);
  assert.equal(outcome({ ...b, header: true }).kind, "fine");
  // out-of-range moves are ignored
  assert.equal(run(init(), { type: "drop", row: 2 }).drop, 4);
  assert.equal(run(init(), { type: "lastUse", row: 8 }).lastUse, 7);
});

test("lifetimes: no annotations is E0106, tying to default_tenant moves the error into the body, String always compiles", () => {
  const e = run(init(), { type: "sig", sig: "elided" });
  assert.equal(verdict(e).code, "E0106");
  assert.equal(verdict(e).at, "sig");
  const f = run(init(), { type: "sig", sig: "fallback" });
  assert.equal(verdict(f).at, "body");
  assert.ok(f.done.includes("body"));
  const o = run(init(), { type: "sig", sig: "owned" }, { type: "header", on: true });
  assert.equal(verdict(o).ok, true);
  assert.equal(outcome(o).kind, "fine");
  assert.ok(o.done.includes("owned"));
});

test("lifetimes: the reader's numbers count distinct layouts", () => {
  const s = run(init(), { type: "header", on: true }, { type: "drop", row: 5 }, { type: "drop", row: 8 }, { type: "sig", sig: "owned" });
  const m = stats(s);
  assert.equal(m.tried, 4, "both|4|7, both|5|7, both|8|7, owned|8|7");
  assert.equal(m.rejected, 2);
  assert.equal(m.dangles, 2);
  assert.ok(s.done.includes("luck") === false, "the header was on for every rejected layout");
});
