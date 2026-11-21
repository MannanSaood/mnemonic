import { test } from "node:test";
import assert from "node:assert/strict";
import { comparison, init, replay, step, syscallsFor, type Action, type State } from "../src/playgrounds/syscall-path/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("syscall-path: unbuffered replay makes two read(2) calls per record", () => {
  assert.equal(syscallsFor(0), 2_000_001);
  const r = replay(0, false, false);
  assert.equal(r.modeSwitches, 4_000_002);
  assert.ok(r.ms > 400 && r.ms < 500, `unbuffered takes about 0.45 s, got ${r.ms}`);
});

test("syscall-path: a 64 KiB buffer cuts syscalls by three orders of magnitude and time by more than 10x", () => {
  assert.equal(syscallsFor(65536), 1527);
  const s = run(init(), { type: "replay" }, { type: "buffer", size: 65536 }, { type: "replay" });
  const c = comparison(s.runs)!;
  assert.ok(c.speedup > 10, `speedup ${c.speedup}`);
  assert.equal(c.slow.syscalls / c.fast.syscalls > 1000, true);
});

test("syscall-path: bigger buffers stop paying off once crossings are rare", () => {
  const k64 = replay(65536, false, false).ms, m1 = replay(1048576, false, false).ms, k4 = replay(4096, false, false).ms;
  assert.ok(k4 > k64 && k64 > m1);
  assert.ok((k64 - m1) / k64 < 0.02, "64 KiB is within 2% of 1 MiB: the copies dominate now");
});

test("syscall-path: stepping unbuffered, every read crosses into the kernel", () => {
  const s = run(init(), { type: "step" }, { type: "step" }, { type: "step" });
  assert.equal(s.stepSyscalls, 3);
  assert.equal(s.trace!.syscall, true);
  assert.ok(s.trace!.hops.some((h) => h.id === "syscall"));
});

test("syscall-path: stepping buffered, only the first read crosses; the rest stay in user space", () => {
  let s = run(init(), { type: "buffer", size: 65536 }, { type: "step" });
  assert.equal(s.trace!.syscall, true);
  assert.equal(s.trace!.count, 65536);
  s = run(s, { type: "step" }, { type: "step" }, { type: "step" });
  assert.equal(s.stepSyscalls, 1);
  assert.equal(s.trace!.syscall, false);
  assert.ok(s.trace!.hops.every((h) => h.layer === "user"));
});

test("syscall-path: strace multiplies the unbuffered cost, and buffering shrinks its effect", () => {
  const plain = replay(0, false, false), traced = replay(0, false, true);
  assert.ok(traced.ms / plain.ms > 50, "strace makes the unbuffered replay over 50x slower");
  const tracedBuf = replay(65536, false, true);
  assert.ok(tracedBuf.ms < 0.1 * traced.ms);
  const s = run(init(), { type: "strace" }, { type: "step" });
  assert.ok(s.trace!.hops.some((h) => h.id === "ptrace"));
});

test("syscall-path: KPTI makes each crossing dearer, so it hurts the unbuffered replay most", () => {
  const extraUnbuf = replay(0, true, false).ms - replay(0, false, false).ms;
  const extraBuf = replay(65536, true, false).ms - replay(65536, false, false).ms;
  assert.ok(extraUnbuf > 300 && extraBuf < 1);
});

test("syscall-path: clock_gettime through the vDSO never leaves user space", () => {
  const s = run(init(), { type: "vdso" });
  assert.equal(s.trace!.syscall, false);
  assert.ok(s.trace!.hops.every((h) => h.layer === "user"));
});

test("syscall-path: the prediction is kept once made, and replays are kept per configuration", () => {
  let s = run(init(), { type: "predict", value: "2x" }, { type: "predict", value: "10x" });
  assert.equal(s.prediction, "2x");
  s = run(s, { type: "replay" }, { type: "replay" }, { type: "strace" }, { type: "replay" });
  assert.equal(s.runs.length, 2);
});
