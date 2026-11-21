import { test } from "node:test";
import assert from "node:assert/strict";
import { SAFE, crashAt, goals, init, isSafe, replyMs, step, steps, sweep, type Action, type Recipe, type State } from "../src/playgrounds/writeback-fsync-and-durability/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const idx = (r: Recipe, id: string) => steps(r).findIndex((x) => x.id === id);

test("crash lab: temp + fsync + rename, no directory fsync, loses the reply (the predict answer)", () => {
  const r: Recipe = { mode: "rename", fsyncFile: true, fsyncDir: false };
  const c = crashAt(r, idx(r, "reply"));
  assert.equal(c.content, "v1");
  assert.equal(c.verdict, "lost-ack");
  assert.equal(crashAt(r, idx(r, "commit")).content, "v2", "the next journal commit makes the rename durable");
  const s = run(init(), { type: "plug", after: idx(r, "reply") });
  assert.equal(goals(s).predictSeen, true);
  assert.equal(goals(s).lostWithFsync, true);
});

test("crash lab: overwriting in place without fsync can leave an empty file", () => {
  const r: Recipe = { mode: "inplace", fsyncFile: false, fsyncDir: false };
  assert.equal(crashAt(r, idx(r, "commitEarly")).content, "empty");
  assert.equal(crashAt(r, idx(r, "reply")).verdict, "empty");
  assert.equal(crashAt(r, idx(r, "writeback")).content, "v2", "after 30 s writeback the data arrives");
  assert.equal(crashAt(r, -1).content, "v1");
});

test("crash lab: fsync before the reply is not enough in place; the truncate can land first", () => {
  const s = sweep({ mode: "inplace", fsyncFile: true, fsyncDir: false });
  assert.equal(s.lostAck, 0);
  assert.ok(s.empty >= 1);
});

test("crash lab: rename without fsyncing the temp file can empty the file", () => {
  const r: Recipe = { mode: "rename", fsyncFile: false, fsyncDir: true };
  assert.equal(crashAt(r, idx(r, "fsyncDir")).content, "empty");
});

test("crash lab: temp + fsync + rename + fsync dir survives every crash, at a cost in latency", () => {
  const s = sweep(SAFE);
  assert.ok(isSafe(s));
  for (const c of s.crashes) assert.ok(c.content !== "empty");
  for (const c of s.crashes) if (c.acked) assert.equal(c.content, "v2");
  assert.ok(replyMs(SAFE) > 10 * replyMs({ mode: "inplace", fsyncFile: false, fsyncDir: false }));
  // only the full recipe is safe
  for (const mode of ["inplace", "rename"] as const) for (const fsyncFile of [false, true]) for (const fsyncDir of [false, true]) {
    const r = { mode, fsyncFile, fsyncDir };
    assert.equal(isSafe(sweep(r)), mode === "rename" && fsyncFile && fsyncDir, JSON.stringify(r));
  }
});

test("crash lab: actions record crashes and sweeps; reset clears", () => {
  let s = run(init(), { type: "mode", mode: "inplace" }, { type: "fsyncFile", on: false }, { type: "sweep" });
  assert.equal(goals(s).empty, true);
  s = run(s, { type: "mode", mode: "rename" }, { type: "fsyncFile", on: true }, { type: "fsyncDir", on: true }, { type: "sweep" });
  assert.equal(goals(s).safe, true);
  assert.equal(s.sweeps.length, 2);
  s = run(s, { type: "plug", after: 99 });
  assert.equal(s.crash, null, "out of range is ignored");
  assert.deepEqual(run(s, { type: "reset" }), init());
});
