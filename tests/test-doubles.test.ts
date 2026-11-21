import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KINDS, init, predictRevealed, runScenario, step, tallyOf, verdict,
  type Action, type Kind, type State,
} from "../src/playgrounds/test-doubles/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const pair = (repo: Kind, mailer: Kind) => run(init(), { type: "pick", slot: "repo", kind: repo }, { type: "pick", slot: "mailer", kind: mailer }, { type: "runAll" });
const tally = (repo: Kind, mailer: Kind) => tallyOf(pair(repo, mailer))!;

test("doubles: mocks on both sides catch every bug and cry wolf on two refactorings", () => {
  const t = tally("mock", "mock");
  assert.equal(t.broken, false);
  assert.equal(t.caught, 5);
  assert.equal(t.falseAlarms, 2);
  assert.equal(verdict(runScenario("r3", "mock", "mock")), "green", "the shared template sends the same email");
});

test("doubles: the repo double never changes which bugs are caught", () => {
  for (const mailer of ["spy", "mock", "fake", "stub"] as Kind[]) {
    const caught = (["stub", "spy", "mock", "fake"] as Kind[]).map((r) => tally(r, mailer).caught);
    assert.ok(caught.every((c) => c === caught[0]), `mailer ${mailer}: ${caught.join(",")}`);
  }
});

test("doubles: verifying the repo's calls breaks on loading the order once", () => {
  for (const repo of ["spy", "mock"] as Kind[]) assert.equal(verdict(runScenario("r1", repo, "mock")), "false-alarm");
  for (const repo of ["stub", "fake"] as Kind[]) assert.equal(verdict(runScenario("r1", repo, "mock")), "green");
});

test("doubles: a joined query breaks per-test stubs, but not a fake", () => {
  assert.equal(verdict(runScenario("r2", "stub", "mock")), "false-alarm");
  assert.equal(verdict(runScenario("r2", "fake", "mock")), "green");
});

test("doubles: stub or fake repo with a mock, spy or fake mailer: 5 of 5, no false alarms", () => {
  for (const mailer of ["mock", "spy", "fake"] as Kind[]) {
    const t = tally("fake", mailer);
    assert.deepEqual([t.caught, t.falseAlarms, t.broken], [5, 0, false]);
  }
  assert.deepEqual([tally("stub", "spy").caught, tally("stub", "spy").falseAlarms], [5, 1]);
});

test("doubles: a stub mailer only catches the bug visible in the return value", () => {
  const s = pair("fake", "stub");
  const missed = Object.values(s.runs).filter((r) => verdict(r!) === "missed").map((r) => r!.scenario);
  assert.deepEqual(missed.sort(), ["b1", "b2", "b3", "b4"]);
  assert.equal(verdict(s.runs.b5!), "caught");
});

test("doubles: a dummy is called, so the suite is red on today's code", () => {
  assert.equal(tally("dummy", "mock").broken, true);
  assert.equal(tally("fake", "dummy").broken, true);
  // ...but the unknown-order test never calls the mailer, so a dummy is fine there.
  const r = runScenario("correct", "fake", "dummy");
  assert.equal(r.tests.find((t) => t.test === "t2")!.pass, true);
});

test("doubles: changing a double clears the runs; history keeps each pair once; prediction reveals after two repos", () => {
  let s = pair("mock", "mock");
  assert.equal(predictRevealed(s), false);
  s = run(s, { type: "pick", slot: "repo", kind: "fake" });
  assert.deepEqual(s.runs, {});
  s = run(s, { type: "runAll" }, { type: "runAll" });
  assert.equal(s.history.length, 2);
  assert.equal(predictRevealed(s), true);
  assert.deepEqual(run(s, { type: "reset" }), init());
  assert.equal(KINDS.length, 5);
});
