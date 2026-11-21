import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER, holders, init, revealed, step, type Action, type State } from "../src/playgrounds/ownership/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("ownership: in Rust, a send moves the buffer and the second use is E0382", () => {
  let s = run(init(), { type: "guess", guess: "error" }, { type: "send", from: "buf" });
  assert.equal(s.slots.buf.movedTo, "audit");
  assert.deepEqual(holders(s, 1), ["audit"], "exactly one owner after the move");
  s = run(s, { type: "put", from: "buf" });
  assert.equal(ANSWER, "error");
  assert.equal(s.run.compileErrors, 1);
  assert.match(s.error ?? "", /E0382/);
  assert.equal(s.slots.pool.block, null, "the refused line changed nothing");
  assert.ok(s.done.includes("refused"));
  assert.ok(revealed(s));
  // reading a moved value is refused as a borrow of a moved value
  s = run(s, { type: "read", v: "buf" });
  assert.match(s.error ?? "", /borrow of moved value/);
});

test("ownership: with a GC, the pool recycles a buffer the audit task still points at", () => {
  let s = run(init(), { type: "mode", mode: "gc" }, { type: "send", from: "buf" }, { type: "put", from: "buf" });
  assert.deepEqual(holders(s, 1).sort(), ["audit", "buf", "pool"]);
  s = run(s, { type: "nextRequest" }, { type: "auditWrite" });
  assert.equal(s.run.wrongEntries, 1);
  assert.equal(s.run.doubleFrees, 0);
  assert.equal(s.run.useAfterFree, 0);
  assert.ok(s.done.includes("wrongEntry"));
});

test("ownership: with manual free, ending ingest frees the buffer audit still uses, then audit frees it again", () => {
  let s = run(init(), { type: "mode", mode: "manual" }, { type: "send", from: "buf" }, { type: "endIngest" });
  assert.equal(s.blocks[0].freed, true);
  s = run(s, { type: "auditWrite" });
  assert.equal(s.run.useAfterFree, 1);
  assert.equal(s.run.doubleFrees, 1);
  assert.equal(s.crashed, true);
  assert.ok(s.done.includes("doubleFree"));
  // after the crash nothing else runs
  assert.equal(run(s, { type: "nextRequest" }), s);
});

test("ownership: with manual free, malloc hands the freed chunk to the next request", () => {
  let s = run(init(), { type: "mode", mode: "manual" }, { type: "send", from: "buf" }, { type: "endIngest" }, { type: "nextRequest" });
  assert.equal(s.slots.next.block, 1, "the allocator reused H1");
  s = run(s, { type: "auditWrite" });
  assert.equal(s.run.wrongEntries, 1, "audit wrote globex's frame");
});

test("ownership: in Rust, scope end drops what is still owned, skips what moved, and frees each block once", () => {
  let s = run(init(), { type: "clone" }, { type: "send", from: "copy" }, { type: "put", from: "buf" });
  assert.equal(s.run.bytesCopied, 4096);
  s = run(s, { type: "endIngest" });
  assert.equal(s.run.frees, 0, "both names moved, nothing to drop");
  s = run(s, { type: "nextRequest" }, { type: "auditWrite" });
  assert.equal(s.run.goodEntries, 1);
  assert.equal(s.run.wrongEntries, 0);
  assert.equal(s.run.frees, 1, "the audit task dropped its copy");
  assert.equal(s.run.doubleFrees, 0);
  assert.ok(s.done.includes("rustBoth"));
});

test("ownership: in Rust, the audit task as last owner frees the buffer once", () => {
  const s = run(init(), { type: "send", from: "buf" }, { type: "endIngest" }, { type: "auditWrite" });
  assert.equal(s.run.frees, 1);
  assert.equal(s.run.goodEntries, 1);
  assert.equal(s.blocks[0].freed, true);
});

test("ownership: totals survive a mode change and reset clears them", () => {
  let s = run(init(), { type: "send", from: "buf" }, { type: "put", from: "buf" }, { type: "mode", mode: "gc" });
  assert.equal(s.totals.rust.compileErrors, 1);
  assert.equal(s.run.steps, 0);
  assert.equal(s.mode, "gc");
  s = run(s, { type: "reset" });
  assert.equal(s.totals.rust.steps, 0);
});
