import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_MIB, FORK_SCENARIO, HOST_MIB, committedMib, init, pageTableMib, proc, sharedCells, step, usedMib,
  type Action, type State,
} from "../src/playgrounds/fork-clone-exec-and-cow/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("fork: copies page tables, not memory, and shares every page", () => {
  const s0 = init();
  const s = run(s0, { type: "fork", pid: 100 });
  const added = usedMib(s) - usedMib(s0);
  assert.equal(added, 16, "8 GiB of 4 KiB pages needs 16 MiB of page-table entries");
  assert.equal(sharedCells(s, 1), 32);
  assert.equal(s.stallMs, 80);
  assert.equal(proc(s, 101)!.kind, "fork");
});

test("fork: each write to a shared page copies it, in parent or child", () => {
  let s = run(init(), { type: "fork", pid: 100 }, { type: "write", pid: 100, cell: 3 }, { type: "write", pid: 101, cell: 5 });
  assert.equal(s.copies, 2);
  assert.equal(sharedCells(s, 1), 30);
  // The second write to a page that is now private does not copy.
  s = run(s, { type: "write", pid: 100, cell: 3 });
  assert.equal(s.copies, 2);
});

test("fork: exec in the child drops its copy and memory falls back", () => {
  const s = run(init(), ...FORK_SCENARIO);
  assert.equal(s.copies, 4);
  assert.equal(sharedCells(s, 1), 0);
  assert.equal(proc(s, 101)!.name, "pdftotext");
  assert.equal(proc(s, 101)!.pid, 101, "exec keeps the pid");
  // Only the 4 copied cells were extra; after exec, the old shared frames are the child's no more.
  assert.ok(usedMib(s) < usedMib(init()) + 4 * CELL_MIB);
});

test("fork: if the parent keeps writing while the child lives, the OOM killer takes the parent", () => {
  let s = run(init(), { type: "fork", pid: 100 });
  for (let i = 0; i < 8 && !s.oom; i++) s = run(s, { type: "burst", pid: 100 });
  assert.equal(s.oom, true);
  assert.equal(proc(s, 100)!.status, "killed");
  assert.ok(s.peakMib >= HOST_MIB);
});

test("spawn: vfork-style spawn copies nothing and stalls the parent for a fraction of a millisecond", () => {
  const s = run(init(), { type: "spawn", pid: 100 }, { type: "burst", pid: 100 });
  assert.equal(s.copies, 0);
  assert.ok(s.stallMs < 1);
  assert.equal(sharedCells(s, 1), 0);
});

test("strict overcommit: fork of the 8 GiB service fails with ENOMEM, spawn works", () => {
  let s = run(init(), { type: "strict" }, { type: "fork", pid: 100 });
  assert.equal(s.failed, 1);
  assert.equal(s.procs.length, 1);
  assert.match(s.events[0].text, /ENOMEM/);
  s = run(s, { type: "spawn", pid: 100 });
  assert.equal(s.procs.length, 2);
  assert.ok(committedMib(s) < 12 * 1024);
});

test("thread: clone with CLONE_VM shares the address space, so its writes never copy", () => {
  const s = run(init(), { type: "thread", pid: 100 }, { type: "write", pid: 101, cell: 0 }, { type: "write", pid: 101, cell: 1 });
  assert.equal(s.copies, 0);
  assert.equal(proc(s, 101)!.mm, proc(s, 100)!.mm);
  assert.equal(pageTableMib(s), 16, "one address space, one set of page tables");
});

test("exit: a forked child that exits gives its shared pages back", () => {
  const s = run(init(), { type: "fork", pid: 100 }, { type: "exit", pid: 101 });
  assert.equal(sharedCells(s, 1), 0);
  assert.equal(usedMib(s), usedMib(init()));
});
