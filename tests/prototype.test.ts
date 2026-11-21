import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO, TEMPLATE_HOST, hostOf, init, shared, step, type Action, type Mode, type State } from "../src/playgrounds/prototype/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const scenario = (mode: Mode) => run(init(), { type: "mode", mode }, ...SCENARIO);

test("prototype: a shallow copy shares the env map, so the US job writes to the EU database", () => {
  const s = scenario("shallow");
  assert.equal(hostOf(s, "us"), "eu-db.internal");
  assert.equal(hostOf(s, "template"), "eu-db.internal", "the template was changed too");
  assert.equal(s.runs[0].wrong, 2);
  assert.equal(shared(s).envs, 1);
});

test("prototype: editing one shallow copy surprises the others", () => {
  const s = run(init(), { type: "clone", region: "us" }, { type: "setHost", region: "us" });
  assert.deepEqual(s.surprised, ["template"]);
});

test("prototype: top-level fields are not shared by a shallow copy", () => {
  const s = run(init(), { type: "clone", region: "us" }, { type: "setRetries", region: "us" });
  assert.deepEqual(s.surprised, []);
});

test("prototype: no copy at all shares even the top-level fields", () => {
  const s = run(init(), { type: "mode", mode: "assign" }, { type: "clone", region: "us" }, { type: "setRetries", region: "us" });
  assert.deepEqual(s.surprised, ["template"]);
});

test("prototype: a deep copy fixes the databases but copies the HTTP pool", () => {
  const s = scenario("deep");
  assert.equal(s.runs[0].wrong, 0);
  assert.equal(s.runs[0].pools, 3);
  assert.equal(hostOf(s, "template"), TEMPLATE_HOST);
});

test("prototype: the job's own clone() copies data and shares the pool", () => {
  const s = scenario("clone");
  assert.equal(s.runs[0].wrong, 0);
  assert.equal(s.runs[0].pools, 1);
  assert.equal(hostOf(s, "us"), "us-db.internal");
});

test("prototype: switching mode keeps earlier runs for comparison", () => {
  let s = scenario("shallow");
  s = run(s, { type: "mode", mode: "clone" }, ...SCENARIO);
  assert.equal(s.runs.length, 2);
});
