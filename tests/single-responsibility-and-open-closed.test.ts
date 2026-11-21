import { test } from "node:test";
import assert from "node:assert/strict";
import { baseline, files, init, replay, step, type Action, type State } from "../src/playgrounds/single-responsibility-and-open-closed/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("srp: one class makes every sprint conflict and drags both other teams into every ticket", () => {
  const t = baseline().tally;
  assert.equal(t.conflicts, 4);
  assert.equal(t.pulled, 16);
  assert.equal(t.surprises, 1, "Finance's rounding change reaches Brand's PDF");
  assert.equal(t.taxEdits, 2);
});

test("srp: the predicted answer, the rounding ticket changes Brand's output in one class", () => {
  const r = baseline().results.find((x) => x.ticket.kind === "rounding")!;
  assert.equal(r.surprise, "brand");
});

test("srp: splitting by team removes cross-team conflicts, but the shared helper still surprises Brand", () => {
  const s = run(init(), { type: "preset", preset: "byTeam" });
  assert.equal(files(s).length, 3);
  const t = replay(s).tally;
  assert.equal(t.conflicts, 1, "two Finance tickets still edit the tax switch in the same sprint");
  assert.equal(t.surprises, 1);
  assert.ok(t.pulled > 0, "Brand still co-owns round2() inside Finance's file");
});

test("srp + ocp: by team, one round2() per team and tax rules as files costs nothing", () => {
  const s = run(init(), { type: "preset", preset: "byTeam" }, { type: "splitRound", on: true }, { type: "plugins", on: true });
  const t = replay(s).tally;
  assert.deepEqual([t.conflicts, t.pulled, t.surprises, t.taxEdits], [0, 0, 0, 0]);
  assert.equal(t.newFiles, 2);
  assert.equal(t.scattered, 0);
});

test("srp: one file per function avoids conflicts but scatters each team's change over several files", () => {
  const s = run(init(), { type: "splitRound", on: true }, { type: "plugins", on: true }, { type: "preset", preset: "perFunction" });
  const t = replay(s).tally;
  assert.equal(t.conflicts, 0);
  assert.equal(t.scattered, 3);
  assert.equal(t.fileCount, 8);
});

test("srp: click a function, click a file to move it; empty files disappear", () => {
  let s = run(init(), { type: "select", unit: "send" }, { type: "move", file: "new" });
  assert.equal(files(s).length, 2);
  s = run(s, { type: "select", unit: "send" }, { type: "move", file: 0 });
  assert.equal(files(s).length, 1);
  assert.equal(s.selected, null);
});

test("srp: prediction locks once the reader has replayed", () => {
  const s = run(init(), { type: "predict", value: "finance" }, { type: "replay" }, { type: "predict", value: "both" });
  assert.equal(s.predict, "finance");
  assert.equal(run(s, { type: "reset" }).replays, 0);
});
