import { test } from "node:test";
import assert from "node:assert/strict";
import { classTree, counts, init, simulate, step, type Action, type State } from "../src/playgrounds/composition-over-inheritance/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("composition: three mixes start as three classes, with auth copied once", () => {
  const c = counts(init());
  assert.equal(c.classes, 3);
  assert.equal(c.fixes.auth, 2);
  assert.equal(c.wrappers, 2);
});

test("composition: logging everywhere adds 4 subclasses but only 1 wrapper", () => {
  const s = run(init(), { type: "logEverywhere" });
  const c = counts(s);
  assert.equal(c.classes - s.before!.classes, 4);
  assert.equal(c.classes, 7, "old classes stay as parents");
  assert.equal(c.fixes.logging, 4, "logging code is written in four classes");
  assert.equal(c.wrappers, 3);
  assert.ok(classTree(s).some((k) => k.name === "LoggingAuthRetryingClient" && k.parent === "AuthRetryingClient"));
});

test("composition: logging outside retry writes one line with the total time", () => {
  const t = simulate("payments", ["logging", "retry", "auth"]);
  assert.equal(t.status, 200);
  assert.equal(t.httpCalls, 2);
  assert.equal(t.logLines.length, 1);
  assert.equal(t.totalMs, 470);
  assert.equal(t.tokenFetches, 2, "auth inside retry fetches a token per attempt");
});

test("composition: moving logging inside retry logs the failed attempt too", () => {
  let s = run(init(), { type: "logEverywhere" }, { type: "select", team: "payments" }, { type: "move", feature: "logging", dir: 1 }, { type: "send" });
  assert.deepEqual(s.teams.payments, ["retry", "logging", "auth"]);
  assert.equal(s.trace!.logLines.length, 2);
  assert.ok(s.trace!.logLines[0].includes("503"));
  s = run(s, { type: "move", feature: "auth", dir: -1 }, { type: "move", feature: "auth", dir: -1 }, { type: "send" });
  assert.equal(s.trace!.tokenFetches, 1, "auth outside retry reuses one token");
});

test("composition: without retry the caller sees the 503", () => {
  const s = run(init(), { type: "select", team: "admin" }, { type: "send" });
  assert.equal(s.trace!.status, 503);
});

test("composition: reordering layers does not change the class tree", () => {
  const a = run(init(), { type: "move", feature: "retry", dir: 1 });
  assert.equal(counts(a).classes, counts(init()).classes);
});
