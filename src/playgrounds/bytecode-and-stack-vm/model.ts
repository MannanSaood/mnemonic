// Bytecode playground: an alert rule compiled once into stack bytecode and run on a small VM,
// next to the tree walker it replaces.
//
// After this, the reader can answer: how does a flat list of instructions with one stack and one
// instruction pointer compute the same answer as walking the tree, and why do `and` and `or`
// compile to jumps (so `requests > 0 and errors / requests > 0.05` never divides by zero)?
//
// The reader edits the host's metrics, steps the VM instruction by instruction (instruction
// pointer, stack, the source span each instruction came from) and compares the counts with the
// tree walker on the same input. Break-it: compile `and`/`or` without jumps, as plain AND/OR
// instructions, and the guarded division runs on an idle service and fails.
//
// Plain state + a pure step function, so it can be tested without a browser.
import { parse, type Expr, type Value } from "../pratt-parsing/model.ts";

export type Op =
  | "CONST" | "LOAD" | "NEG" | "NOT"
  | "ADD" | "SUB" | "MUL" | "DIV" | "EQ" | "NE" | "LT" | "LE" | "GT" | "GE"
  | "AND" | "OR"
  | "JUMP_IF_FALSE_OR_POP" | "JUMP_IF_TRUE_OR_POP" | "RETURN";

export interface Instr { op: Op; arg: number | null; span: [number, number] }
export interface Chunk { code: Instr[]; consts: Value[]; slots: string[] }

const BINOP: Record<string, Op> = { "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "==": "EQ", "!=": "NE", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE", and: "AND", or: "OR" };

export function span(e: Expr): [number, number] {
  if (e.kind === "leaf") return [e.tok.start, e.tok.end];
  if (e.kind === "unary") { const [, b] = span(e.x); return [Math.max(0, span(e.x)[0] - (e.op === "not" ? 4 : 1)), b]; }
  return [span(e.left)[0], span(e.right)[1]];
}

/** Compile a tree into a chunk, in one post-order pass. `jumps` false = the break-it version. */
export function compile(tree: Expr, opts: { jumps: boolean } = { jumps: true }): Chunk {
  const c: Chunk = { code: [], consts: [], slots: [] };
  const emit = (op: Op, arg: number | null, s: [number, number]) => { c.code.push({ op, arg, span: s }); return c.code.length - 1; };
  const constant = (v: Value) => { const i = c.consts.indexOf(v); return i >= 0 ? i : c.consts.push(v) - 1; };
  const slot = (name: string) => { const i = c.slots.indexOf(name); return i >= 0 ? i : c.slots.push(name) - 1; };
  const go = (e: Expr) => {
    const s = span(e);
    if (e.kind === "leaf") {
      const t = e.tok;
      if (t.kind === "ident") emit("LOAD", slot(t.text), s);
      else emit("CONST", constant(t.kind === "number" ? Number(t.text) : t.kind === "string" ? t.text.slice(1, -1) : t.text === "true"), s);
      return;
    }
    if (e.kind === "unary") { go(e.x); emit(e.op === "not" ? "NOT" : "NEG", null, s); return; }
    go(e.left);
    if ((e.op === "and" || e.op === "or") && opts.jumps) {
      const j = emit(e.op === "and" ? "JUMP_IF_FALSE_OR_POP" : "JUMP_IF_TRUE_OR_POP", -1, s);
      go(e.right);
      c.code[j].arg = c.code.length; // patch: jump to just past the right side
      return;
    }
    go(e.right);
    emit(BINOP[e.op], null, s);
  };
  go(tree);
  emit("RETURN", null, span(tree));
  return c;
}

/* ---------------- the VM ---------------- */

export interface VM {
  ip: number;
  stack: Value[];
  executed: number;
  maxStack: number;
  jumpsTaken: number;
  /** Instructions passed over by jumps. */
  skipped: number;
  /** Index of the instruction that ran last. */
  last: number | null;
  done: boolean;
  result: Value | null;
  error: string | null;
}

export const vmInit = (): VM => ({ ip: 0, stack: [], executed: 0, maxStack: 0, jumpsTaken: 0, skipped: 0, last: null, done: false, result: null, error: null });

const fmt = (v: Value) => JSON.stringify(v);
function needBool(op: string, v: Value): boolean { if (typeof v !== "boolean") throw new Error(`${op} needs a boolean, got ${fmt(v)}`); return v; }
function needNum(op: string, v: Value): number { if (typeof v !== "number") throw new Error(`${op} needs numbers, got ${fmt(v)}`); return v; }

function binary(op: Op, a: Value, b: Value): Value {
  switch (op) {
    case "EQ": return a === b;
    case "NE": return a !== b;
    case "AND": return needBool("and", a) && needBool("and", b);
    case "OR": return needBool("or", a) || needBool("or", b);
  }
  const x = needNum(op, a), y = needNum(op, b);
  switch (op) {
    case "ADD": return x + y;
    case "SUB": return x - y;
    case "MUL": return x * y;
    case "DIV": if (y === 0) throw new Error("division by zero"); return x / y;
    case "LT": return x < y;
    case "LE": return x <= y;
    case "GT": return x > y;
    case "GE": return x >= y;
  }
  throw new Error(`not a binary op: ${op}`);
}

/** Execute one instruction. Pure: returns a new VM. */
export function vmStep(c: Chunk, slots: Value[], vm: VM): VM {
  if (vm.done) return vm;
  const ins = c.code[vm.ip];
  const stack = [...vm.stack];
  let ip = vm.ip + 1;
  let jumped = 0;
  try {
    switch (ins.op) {
      case "CONST": stack.push(c.consts[ins.arg!]); break;
      case "LOAD": stack.push(slots[ins.arg!]); break;
      case "NEG": stack.push(-needNum("-", stack.pop()!)); break;
      case "NOT": stack.push(!needBool("not", stack.pop()!)); break;
      case "JUMP_IF_FALSE_OR_POP":
      case "JUMP_IF_TRUE_OR_POP": {
        const top = needBool(ins.op === "JUMP_IF_FALSE_OR_POP" ? "and" : "or", stack[stack.length - 1]);
        if (top === (ins.op === "JUMP_IF_TRUE_OR_POP")) { jumped = ins.arg! - ip; ip = ins.arg!; } else stack.pop();
        break;
      }
      case "RETURN": {
        const result = stack.pop()!;
        return { ...vm, stack, ip, executed: vm.executed + 1, last: vm.ip, done: true, result };
      }
      default: {
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(binary(ins.op, a, b));
      }
    }
  } catch (e) {
    return { ...vm, executed: vm.executed + 1, last: vm.ip, done: true, error: (e as Error).message };
  }
  return {
    ...vm, ip, stack, executed: vm.executed + 1, last: vm.ip,
    maxStack: Math.max(vm.maxStack, stack.length),
    jumpsTaken: vm.jumpsTaken + (jumped ? 1 : 0), skipped: vm.skipped + jumped,
  };
}

export function runToEnd(c: Chunk, slots: Value[], vm: VM = vmInit()): VM {
  let v = vm;
  for (let guard = 0; !v.done && guard < 10_000; guard++) v = vmStep(c, slots, v);
  return v;
}

/* ---------------- the tree walker, counted ---------------- */

export interface WalkResult { value: Value | null; error: string | null; visits: number; lookups: number; depth: number }

/** The tree-walking evaluator from the Problem step, with counters. Short-circuits like the VM. */
export function walk(tree: Expr, env: Record<string, Value>): WalkResult {
  let visits = 0, lookups = 0, depth = 0;
  const ev = (e: Expr, d: number): Value => {
    visits++;
    depth = Math.max(depth, d);
    if (e.kind === "leaf") {
      const t = e.tok;
      if (t.kind === "ident") { lookups++; if (!(t.text in env)) throw new Error(`unknown metric ${t.text}`); return env[t.text]; }
      return t.kind === "number" ? Number(t.text) : t.kind === "string" ? t.text.slice(1, -1) : t.text === "true";
    }
    if (e.kind === "unary") { const x = ev(e.x, d + 1); return e.op === "not" ? !needBool("not", x) : -needNum("-", x); }
    const a = ev(e.left, d + 1);
    if (e.op === "and" && needBool("and", a) === false) return false;
    if (e.op === "or" && needBool("or", a) === true) return true;
    return binary(BINOP[e.op], a, ev(e.right, d + 1));
  };
  try { return { value: ev(tree, 1), error: null, visits, lookups, depth }; }
  catch (e) { return { value: null, error: (e as Error).message, visits, lookups, depth }; }
}

/* ---------------- presets, scale, state ---------------- */

export const PRESETS = [
  { label: "Guarded ratio", src: "requests > 0 and errors / requests > 0.05" },
  { label: "Mixed and/or", src: 'cpu > 0.95 or mem > 0.9 and env == "prod"' },
  { label: "Error budget", src: "(errors + timeouts) / requests * 100 > 5 and not env == \"dev\"" },
];

/** The service the rule runs against: quiet at night, so requests is 0. */
export const DEFAULT_HOST: Record<string, Value> = { requests: 0, errors: 0, timeouts: 0, cpu: 0.97, mem: 0.5, env: "prod" };
export const SCALE = { rules: 200, series: 50_000, everySeconds: 10 };

export type Goal = "jump" | "compare" | "broken";
export const GOALS: { id: Goal; text: string }[] = [
  { id: "jump", text: "Step the guarded ratio until a jump skips the division." },
  { id: "compare", text: "Give the service traffic (requests above 0) and run it to the end again." },
  { id: "broken", text: "Break it: compile and/or without jumps and run the guarded ratio on the idle service." },
];

export interface State {
  src: string;
  host: Record<string, Value>;
  jumps: boolean;
  vm: VM;
  goals: Record<Goal, boolean>;
  /** Runs completed by the reader (VM reached RETURN or an error). */
  runs: number;
}

export type Action =
  | { type: "preset"; index: number }
  | { type: "edit"; src: string }
  | { type: "host"; key: string; value: Value }
  | { type: "jumps" }
  | { type: "step" }
  | { type: "run" }
  | { type: "restart" }
  | { type: "reset" };

export function init(): State {
  return { src: PRESETS[0].src, host: { ...DEFAULT_HOST }, jumps: true, vm: vmInit(), goals: { jump: false, compare: false, broken: false }, runs: 0 };
}

export interface Program { tree: Expr | null; error: string | null; chunk: Chunk | null; slots: Value[] }

/** Parse and compile the current rule, and fill the slot array from the host once. */
export function program(st: Pick<State, "src" | "host" | "jumps">): Program {
  const r = parse(st.src);
  if (!r.tree) return { tree: null, error: r.error, chunk: null, slots: [] };
  const chunk = compile(r.tree, { jumps: st.jumps });
  const missing = chunk.slots.find((s) => !(s in st.host));
  if (missing) return { tree: r.tree, error: `unknown metric ${missing}`, chunk: null, slots: [] };
  return { tree: r.tree, error: null, chunk, slots: chunk.slots.map((s) => st.host[s]) };
}

function observe(st: State, prev: VM): State {
  const g = { ...st.goals };
  const v = st.vm;
  if (st.src === PRESETS[0].src && st.jumps && v.jumpsTaken > 0) g.jump = true;
  const finished = v.done && !prev.done;
  if (finished && st.src === PRESETS[0].src && st.jumps && Number(st.host.requests) > 0 && !v.error) g.compare = true;
  if (finished && st.src === PRESETS[0].src && !st.jumps && v.error === "division by zero") g.broken = true;
  return { ...st, goals: g, runs: st.runs + (finished ? 1 : 0) };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "preset": return { ...st, src: PRESETS[a.index].src, vm: vmInit() };
    case "edit": return { ...st, src: a.src, vm: vmInit() };
    case "host": return { ...st, host: { ...st.host, [a.key]: a.value }, vm: vmInit() };
    case "jumps": return { ...st, jumps: !st.jumps, vm: vmInit() };
    case "restart": return { ...st, vm: vmInit() };
    case "step":
    case "run": {
      const p = program(st);
      if (!p.chunk || st.vm.done) return st;
      const vm = a.type === "step" ? vmStep(p.chunk, p.slots, st.vm) : runToEnd(p.chunk, p.slots, st.vm);
      return observe({ ...st, vm }, st.vm);
    }
  }
}

/** One line in the style of Python's dis: offset, opcode, argument and what it refers to. */
export function disasm(c: Chunk, i: number): { offset: string; op: string; arg: string; note: string } {
  const ins = c.code[i];
  const note = ins.op === "CONST" ? `(${fmt(c.consts[ins.arg!])})` : ins.op === "LOAD" ? `(${c.slots[ins.arg!]})` : ins.op.startsWith("JUMP") ? `(to ${ins.arg})` : "";
  return { offset: String(i), op: ins.op, arg: ins.arg === null ? "" : String(ins.arg), note };
}

/** What the instruction about to run does, in one line. */
export function describe(c: Chunk, ins: Instr): string {
  switch (ins.op) {
    case "CONST": return `Push the constant ${fmt(c.consts[ins.arg!])}.`;
    case "LOAD": return `Push slot ${ins.arg}, the metric ${c.slots[ins.arg!]}. The name was turned into a slot number once, at compile time.`;
    case "NEG": return "Pop a number, push its negation.";
    case "NOT": return "Pop a boolean, push its opposite.";
    case "JUMP_IF_FALSE_OR_POP": return `If the top is false, the and is already false: keep it and jump to ${ins.arg}, skipping the right side. Otherwise pop it and go on.`;
    case "JUMP_IF_TRUE_OR_POP": return `If the top is true, the or is already true: keep it and jump to ${ins.arg}, skipping the right side. Otherwise pop it and go on.`;
    case "AND": return "Pop two booleans, push both-true. Both sides have already run: there is no way to skip one.";
    case "OR": return "Pop two booleans, push either-true. Both sides have already run.";
    case "RETURN": return "Pop the result and stop.";
    default: return `Pop two values, apply ${ins.op}, push the result.`;
  }
}

/** Indexes of the instructions that have run, replayed from the start for `executed` steps. */
export function history(c: Chunk, slots: Value[], executed: number): number[] {
  const out: number[] = [];
  let v = vmInit();
  for (let i = 0; i < executed && !v.done; i++) { v = vmStep(c, slots, v); out.push(v.last!); }
  return out;
}

/** Compact count: 1234567 -> "1.2 M". */
export function big(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)} k`;
  return String(n);
}
