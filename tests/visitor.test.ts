import { test } from "node:test";
import assert from "node:assert/strict";
import { build, compiles, estimate, init, requestDone, step, traceOf, trueEstimate, type Action, type Design, type Op, type Res, type State } from "../src/playgrounds/visitor/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const BASE: Res[] = ["network", "database", "bucket", "lb"];
const writeAll = (design: Design, opsList: Op[], res: Res[]): Action[] => opsList.flatMap((op) => res.map((r) => ({ type: "write", design, op, res: r }) as Action));

test("visitor: adding an operation edits every resource file with methods, and no existing file with Visitor", () => {
  const s = run(init(), ...writeAll("methods", ["cost"], BASE), ...writeAll("visitor", ["cost"], BASE));
  assert.ok(requestDone(s));
  assert.equal(s.methods.edited.length, 4);
  assert.equal(s.methods.created.length, 0);
  assert.equal(s.visitor.edited.length, 0);
  assert.deepEqual(s.visitor.created, ["cost visitor"]);
  assert.equal(estimate(s, "visitor"), estimate(s, "methods"));
});

test("visitor: a half-written operation does not build in either design", () => {
  const s = run(init(), { type: "write", design: "methods", op: "cost", res: "database" }, { type: "write", design: "visitor", op: "cost", res: "database" });
  assert.equal(compiles(s, "methods"), false);
  assert.equal(compiles(s, "visitor"), false);
  assert.equal(estimate(s, "visitor"), null);
});

test("visitor: adding a resource type creates one file with methods, and edits the interface and every visitor with Visitor", () => {
  let s = run(init(), ...writeAll("methods", ["cost"], BASE), ...writeAll("visitor", ["cost"], BASE), { type: "next" });
  assert.equal(s.request, 1);
  assert.ok(build(s, "visitor").some((i) => /no such method/.test(i.text)), "Queue.Accept needs the interface method");
  s = run(s, ...writeAll("methods", ["validate", "render", "cost"], ["queue"]), { type: "declareQueue" }, ...writeAll("visitor", ["validate", "render", "cost"], ["queue"]));
  assert.ok(requestDone(s));
  assert.equal(s.methods.edited.length, 0);
  assert.deepEqual(s.methods.created, ["queue"]);
  assert.equal(s.visitor.edited.length, 4); // interface + validate, render, cost visitors
  assert.equal(estimate(s, "visitor"), trueEstimate(s));
  s = run(s, { type: "next" });
  assert.equal(s.request, 2);
  assert.equal(s.results[0].methods.edited, 4);
  assert.equal(s.results[0].visitor.edited, 0);
  assert.equal(s.results[1].methods.edited, 0);
  assert.equal(s.results[1].visitor.edited, 4);
});

test("visitor: empty default visits make a missing cell compile and give a silently wrong estimate", () => {
  let s = run(init(), ...writeAll("methods", ["cost"], BASE), ...writeAll("visitor", ["cost"], BASE), { type: "next" });
  s = run(s, { type: "declareQueue" }, { type: "toggleDefaults" });
  assert.ok(compiles(s, "visitor"), "the build is green");
  assert.equal(estimate(s, "visitor"), trueEstimate(s) - 4, "the queue is costed at $0");
  assert.ok(build(s, "visitor").some((i) => i.silent && /never deployed/.test(i.text)));
  assert.equal(requestDone(s), false, "silent gaps do not count as done");
  assert.equal(traceOf(s, "visitor", "queue").hops.at(-1), "$0");
});

test("visitor: a Visitor call takes two dispatches, a method call one", () => {
  const s = run(init(), ...writeAll("methods", ["cost"], BASE), ...writeAll("visitor", ["cost"], BASE));
  assert.equal(traceOf(s, "methods", "database").hops.length, 3);
  const v = traceOf(s, "visitor", "database");
  assert.ok(v.ok);
  assert.ok(v.hops.includes("Database.Accept") && v.hops.includes("CostVisitor.VisitDatabase"));
});
