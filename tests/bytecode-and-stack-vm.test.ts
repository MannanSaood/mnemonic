import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/playgrounds/pratt-parsing/model.ts";
import {
  DEFAULT_HOST, PRESETS, compile, disasm, init, program, runToEnd, step, walk, type Action, type State,
} from "../src/playgrounds/bytecode-and-stack-vm/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const listing = (src: string, jumps = true) => { const c = compile(parse(src).tree!, { jumps }); return c.code.map((_, i) => { const d = disasm(c, i); return `${d.op}${d.note ? " " + d.note : ""}`; }); };

test("vm: the guarded ratio compiles to 10 instructions with a patched jump past the division", () => {
  assert.deepEqual(listing(PRESETS[0].src), [
    "LOAD (requests)", "CONST (0)", "GT", "JUMP_IF_FALSE_OR_POP (to 9)",
    "LOAD (errors)", "LOAD (requests)", "DIV", "CONST (0.05)", "GT", "RETURN",
  ]);
  const c = compile(parse(PRESETS[0].src).tree!);
  assert.deepEqual(c.slots, ["requests", "errors"], "each name gets one slot, reused");
});

test("vm: on the idle service only 5 instructions run, and the jump skips 5", () => {
  const p = program({ src: PRESETS[0].src, host: DEFAULT_HOST, jumps: true });
  const vm = runToEnd(p.chunk!, p.slots);
  assert.equal(vm.result, false);
  assert.equal(vm.error, null);
  assert.equal(vm.executed, 5);
  assert.equal(vm.jumpsTaken, 1);
  assert.equal(vm.skipped, 5);
  assert.equal(vm.maxStack, 2);
});

test("vm: without jumps, and becomes an AND instruction and the division runs and fails", () => {
  assert.deepEqual(listing(PRESETS[0].src, false).slice(-2), ["AND", "RETURN"]);
  const p = program({ src: PRESETS[0].src, host: DEFAULT_HOST, jumps: false });
  const vm = runToEnd(p.chunk!, p.slots);
  assert.equal(vm.error, "division by zero");
  assert.equal(walk(p.tree!, DEFAULT_HOST).value, false, "the tree walker short-circuits, so it never divides");
});

test("vm: the VM and the tree walker agree on every preset and several hosts", () => {
  const hosts = [DEFAULT_HOST, { ...DEFAULT_HOST, requests: 400, errors: 30, timeouts: 4 }, { ...DEFAULT_HOST, requests: 100, errors: 1, env: "dev", cpu: 0.2, mem: 0.95 }];
  for (const p of PRESETS) for (const host of hosts) {
    const prog = program({ src: p.src, host, jumps: true });
    const vm = runToEnd(prog.chunk!, prog.slots);
    const w = walk(prog.tree!, host);
    assert.deepEqual([vm.result, vm.error], [w.value, w.error], `${p.src} on ${JSON.stringify(host)}`);
  }
});

test("vm: mixed and/or uses both jump kinds; the walker visits nodes and looks up names", () => {
  assert.ok(listing(PRESETS[1].src).includes("JUMP_IF_TRUE_OR_POP (to 11)"));
  const prog = program({ src: PRESETS[1].src, host: DEFAULT_HOST, jumps: true });
  const vm = runToEnd(prog.chunk!, prog.slots);
  assert.equal(vm.result, true);
  const w = walk(prog.tree!, DEFAULT_HOST);
  assert.equal(w.value, true);
  assert.equal(w.visits, 4);
  assert.equal(w.lookups, 1);
  assert.equal(vm.executed, 5);
});

test("vm: stepping, goals and reset", () => {
  let s = init();
  for (let i = 0; i < 4; i++) s = run(s, { type: "step" });
  assert.equal(s.vm.ip, 9);
  assert.equal(s.goals.jump, true);
  s = run(s, { type: "run" });
  assert.equal(s.vm.done, true);
  assert.equal(s.runs, 1);
  s = run(s, { type: "host", key: "requests", value: 400 }, { type: "host", key: "errors", value: 30 }, { type: "run" });
  assert.equal(s.vm.result, true);
  assert.equal(s.goals.compare, true);
  s = run(s, { type: "host", key: "requests", value: 0 }, { type: "jumps" }, { type: "run" });
  assert.equal(s.vm.error, "division by zero");
  assert.equal(s.goals.broken, true);
  s = run(s, { type: "reset" });
  assert.equal(s.runs, 0);
  assert.equal(s.jumps, true);
});

test("vm: a rule that does not parse or names an unknown metric gives no program", () => {
  assert.match(program({ src: "requests >", host: DEFAULT_HOST, jumps: true }).error!, /expected an operand/);
  assert.equal(program({ src: "latency > 3", host: DEFAULT_HOST, jumps: true }).error, "unknown metric latency");
});
