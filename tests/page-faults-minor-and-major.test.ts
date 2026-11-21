import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO, access, init, requestSummary, rss, step, type Action, type State } from "../src/playgrounds/page-faults-minor-and-major/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const touch = (s: State, vpage: number, mode: "read" | "write" = "read") => access(s, s.pid, vpage, mode).touch;

test("page-faults: a cold index page is a major fault; a page already in the page cache is minor", () => {
  const s = init();
  assert.equal(touch(s, 0).kind, "major");
  assert.equal(touch(s, 2).kind, "minor");
  assert.equal(touch(s, 2).why, "cache");
  assert.ok(touch(s, 0).us > 500 * touch(s, 2).us, "disk costs hundreds of times more");
});

test("page-faults: a second touch of a mapped page does not fault", () => {
  const s = run(init(), { type: "touch", vpage: 0 });
  assert.equal(touch(s, 0).kind, "none");
});

test("page-faults: reading fresh heap maps the zero page; writing allocates a zeroed frame", () => {
  let s = run(init(), { type: "touch", vpage: 7 });
  assert.equal(s.last!.why, "zero-page");
  assert.equal(s.tables.parent[7].frame, ZERO);
  assert.equal(rss(s, "parent"), 0, "the zero page uses no new RAM");
  s = run(s, { type: "mode", mode: "write" }, { type: "touch", vpage: 7 });
  assert.equal(s.last!.why, "zero-fill");
  assert.equal(rss(s, "parent"), 1);
});

test("page-faults: writes to the read-only index and touches outside any mapping are SIGSEGV", () => {
  const s = run(init(), { type: "mode", mode: "write" }, { type: "touch", vpage: 1 });
  assert.equal(s.last!.kind, "segv");
  assert.equal(run(init(), { type: "touch", vpage: 11 }).last!.why, "no-vma");
});

test("page-faults: the first request after start waits on the disk; the second does not", () => {
  const s = run(init(), { type: "request" }, { type: "request" });
  const [cold, warm] = s.requests;
  assert.equal(cold.major, 3);
  assert.ok(cold.us > 3000);
  assert.equal(warm.major, 0);
  assert.equal(warm.minor, 0);
  assert.ok(warm.us < 1);
  const sum = requestSummary(s.requests)!;
  assert.ok(sum.cold.us / sum.warm.us > 1000);
});

test("page-faults: memory pressure evicts clean file pages, and the next request faults again", () => {
  const s = run(init(), { type: "request" }, { type: "pressure" }, { type: "request" });
  assert.equal(s.requests[1].major, 4, "even page 2, which the backup had cached, is gone now");
});

test("page-faults: prefaulting moves the disk time to startup, so the first request is fast", () => {
  const s = run(init(), { type: "populate" }, { type: "request" });
  assert.equal(s.requests[0].major, 0);
  assert.equal(s.requests[0].minor, 1, "only the heap write faults");
  assert.ok(s.startupUs > 5000);
});

test("page-faults: after fork, the first write in either process copies the page", () => {
  let s = run(init(), { type: "mode", mode: "write" }, { type: "touch", vpage: 6 }, { type: "fork" });
  assert.equal(s.pid, "child");
  assert.equal(s.tables.child[6].frame, s.tables.parent[6].frame, "shared after fork");
  assert.equal(s.tables.parent[6].writable, false);
  s = run(s, { type: "touch", vpage: 6 });
  assert.equal(s.last!.why, "cow");
  assert.notEqual(s.tables.child[6].frame, s.tables.parent[6].frame);
  // The parent is now the last user of the old frame: it faults, but no copy is needed.
  s = run(s, { type: "pid", pid: "parent" }, { type: "touch", vpage: 6 });
  assert.equal(s.last!.why, "reuse");
  assert.equal(s.counters.child.cow, 1);
});

test("page-faults: after fork the child refaults the shared index from the page cache: minor, not major", () => {
  const s = run(init(), { type: "touch", vpage: 0 }, { type: "fork" }, { type: "touch", vpage: 0 });
  assert.equal(s.last!.kind, "minor");
  assert.equal(s.last!.why, "cache");
  assert.equal(s.tables.child[0].frame, s.tables.parent[0].frame, "same page cache frame, no copy");
});
