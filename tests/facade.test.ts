import { test } from "node:test";
import assert from "node:assert/strict";
import { init, mustEdit, step, wires, type Action, type State } from "../src/playgrounds/facade/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("facade: with no facade, the scan change touches the three deploy scripts", () => {
  assert.deepEqual(mustEdit(init()), ["ci", "chatops", "hotfix"]);
});

test("facade: a missed caller ships an unscanned image and reports success (the predict answer)", () => {
  const s = run(init(), { type: "edit", file: "ci" }, { type: "ship" });
  const bot = s.lastRun.find((e) => e.caller === "chatops")!;
  assert.equal(bot.ok, true);
  assert.equal(bot.silent, true);
  assert.equal(s.lastRun.find((e) => e.caller === "ci")!.silent, false);
  assert.equal(s.silent, 2);
});

test("facade: routing the three deploy callers through the facade makes every change one edit", () => {
  let s = run(init(), { type: "route", caller: "ci" }, { type: "route", caller: "chatops" }, { type: "route", caller: "hotfix" });
  assert.deepEqual(mustEdit(s), ["facade"]);
  s = run(s, { type: "edit", file: "facade" }, { type: "ship" });
  assert.equal(s.broken + s.silent, 0);
  s = run(s, { type: "next" }, { type: "edit", file: "facade" }, { type: "ship" }, { type: "next" });
  assert.deepEqual(mustEdit(s), ["rollback", "facade"], "the notify change also reaches the rollback script");
  s = run(s, { type: "edit", file: "facade" }, { type: "edit", file: "rollback" }, { type: "ship" }, { type: "next" });
  assert.deepEqual(s.results.map((r) => r.edits), [1, 1, 2]);
  assert.ok(s.results.every((r) => r.edits === r.best && r.broken === 0 && r.silent === 0));
});

test("facade: a missed caller breaks loudly on the registry change, and is counted as a late edit", () => {
  let s = run(init(), { type: "edit", file: "ci" }, { type: "edit", file: "chatops" }, { type: "edit", file: "hotfix" }, { type: "ship" }, { type: "next" });
  s = run(s, { type: "edit", file: "ci" }, { type: "ship" });
  assert.equal(s.broken, 2);
  assert.ok(s.lastRun.find((e) => e.caller === "hotfix")!.path.includes("push ✗"));
  s = run(s, { type: "next" });
  assert.equal(s.results[1].edits, 3);
  assert.equal(s.results[1].late, 2);
});

test("facade: forcing the rollback through Deploy() runs migrations forward", () => {
  const s = run(init(), { type: "route", caller: "rollback" }, { type: "edit", file: "ci" }, { type: "ship" });
  const rb = s.lastRun.find((e) => e.caller === "rollback")!;
  assert.equal(rb.ok, false);
  assert.ok(rb.path.includes("migrate ↑"));
});

test("facade: the facade cuts the number of caller-to-subsystem dependencies", () => {
  const before = wires(init());
  const after = wires(run(init(), { type: "route", caller: "ci" }, { type: "route", caller: "chatops" }, { type: "route", caller: "hotfix" }));
  assert.equal(before, 3 * 6 + 3);
  assert.equal(after, 3 + 3 + 6);
  assert.ok(after < before);
});
