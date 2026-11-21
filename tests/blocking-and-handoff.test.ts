import { test } from "node:test";
import assert from "node:assert/strict";
import { ARRIVALS_IN_BLOCK, BLOCK_AT, PROCS, init, parked, simulate, step, threadsInSyscall, totalArrivals, type Action, type State } from "../src/playgrounds/blocking-and-handoff/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const ticks = (s: State, n: number) => { for (let i = 0; i < n; i++) s = step(s, { type: "tick" }); return s; };

test("blocking: without any blocking call, two Ps keep up with the traffic", () => {
  const r = simulate("net", true);
  assert.equal(r.served, totalArrivals());
  assert.equal(r.servedDuringBlock, ARRIVALS_IN_BLOCK);
});

test("blocking: a channel wait and a network read park the goroutine and cost no thread", () => {
  for (const op of ["chan", "net"] as const) {
    const r = simulate(op, true);
    assert.equal(r.threads, PROCS, op);
    assert.equal(r.handoffs, 0, op);
    assert.equal(r.servedDuringBlock, ARRIVALS_IN_BLOCK, op);
    assert.ok(r.worstWaitMs <= 1, op);
  }
});

test("blocking: a network read sits on the netpoller, not in the kernel on a thread", () => {
  let s = run(init(), { type: "op", op: "net" });
  s = ticks(s, BLOCK_AT + 3);
  assert.equal(parked(s, "netpoller").length, 1);
  assert.equal(threadsInSyscall(s), 0);
});

test("blocking: a file read takes its thread into the kernel, and sysmon hands the P to a new thread", () => {
  let s = run(init(), { type: "op", op: "file" });
  s = ticks(s, BLOCK_AT + 1);
  assert.equal(threadsInSyscall(s), 1);
  assert.equal(s.ps.filter((p) => p.status === "syscall").length, 1, "the P waits in syscall state first");
  s = ticks(s, 3);
  assert.equal(s.handoffs, 1);
  assert.equal(s.ms.length, PROCS + 1, "a new M runs the P");
  assert.equal(s.ps.filter((p) => p.status === "syscall").length, 0);
});

test("blocking: with the hand-off, a file read barely hurts the other requests", () => {
  const r = simulate("file", true);
  assert.equal(r.servedDuringBlock, ARRIVALS_IN_BLOCK);
  assert.ok(r.worstWaitMs <= 2);
  assert.equal(r.threads, 3);
});

test("blocking: without the hand-off, a third of the requests in the block are late and one waits 20 ms", () => {
  const r = simulate("file", false);
  assert.equal(r.servedDuringBlock, 30);
  assert.ok(r.worstWaitMs >= 15, String(r.worstWaitMs));
  assert.equal(r.threads, PROCS);
});

test("blocking: four blocking reads at once cost four extra threads; without the hand-off everything stops", () => {
  const on = simulate("file", true, 4), off = simulate("file", false, 4);
  assert.equal(on.threads, PROCS + 4);
  assert.equal(on.servedDuringBlock, ARRIVALS_IN_BLOCK);
  assert.equal(off.servedDuringBlock, 0, "both Ps are stuck in syscalls");
});

test("blocking: when the reads return and every P is taken, the threads park as idle threads", () => {
  const r = simulate("file", true, 4);
  assert.equal(r.idleThreads, 4);
});

test("blocking: the prediction locks once a file read has run", () => {
  let s = run(init(), { type: "guess", guess: "stall" }, { type: "finish" });
  assert.equal(s.runs.length, 1);
  assert.equal(run(s, { type: "guess", guess: "handoff" }).guess, "stall");
  s = run(s, { type: "clear" });
  assert.equal(s.runs.length, 1);
  assert.equal(s.t, 0);
});
