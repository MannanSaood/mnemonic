// Pratt parsing playground: an alert rule parsed by one loop and a table of binding powers.
//
// After this, the reader can answer: in a Pratt parser, how does a number in a table decide
// which operator gets the operand between two of them (the higher binding power grabs it), and
// how do equal powers give left associativity?
//
// The reader steps parseExpr through `cpu > 0.95 or mem > 0.9 and env == "prod"`: each call
// frame shows its minimum binding power, and each operator shows the comparison that decides
// whether it binds. The tree grows bottom-up as nodes are built. The reader edits the binding
// powers (and associativity) in the table and sees the same tokens parse into a different tree,
// and the alert for a staging host flip from paging to silent. Break-it: put comparison below
// `and`, and the rule parses but cannot be evaluated.
//
// Plain state + a pure step function, so it can be tested without a browser.
import { lex, type Token } from "../lexing-and-tokens/model.ts";

/* ---------------- the binding power table ---------------- */

export type RowKey = "or" | "and" | "cmp" | "add" | "mul";
export interface Row { key: RowKey; ops: string[]; bp: number; assoc: "left" | "right" }

export const DEFAULT_TABLE: Row[] = [
  { key: "or", ops: ["or"], bp: 1, assoc: "left" },
  { key: "and", ops: ["and"], bp: 2, assoc: "left" },
  { key: "cmp", ops: ["==", "!=", "<", "<=", ">", ">="], bp: 4, assoc: "left" },
  { key: "add", ops: ["+", "-"], bp: 5, assoc: "left" },
  { key: "mul", ops: ["*", "/"], bp: 6, assoc: "left" },
];
/** Prefix operators parse their operand at a fixed power: `not` below comparisons, `-` above all. */
export const PREFIX_BP: Record<string, number> = { not: 3, "-": 7 };
export const BP_MIN = 1, BP_MAX = 9;

export function rowOf(table: Row[], tok: Token): Row | null {
  if (tok.kind !== "op" && tok.kind !== "keyword") return null;
  return table.find((r) => r.ops.includes(tok.text)) ?? null;
}

/* ---------------- the tree ---------------- */

export type Expr =
  | { id: number; kind: "leaf"; tok: Token }
  | { id: number; kind: "unary"; op: string; x: Expr }
  | { id: number; kind: "binary"; op: string; left: Expr; right: Expr };

export function print(e: Expr): string {
  switch (e.kind) {
    case "leaf": return e.tok.text;
    case "unary": return `(${e.op}${e.op === "not" ? " " : ""}${print(e.x)})`;
    case "binary": return `(${print(e.left)} ${e.op} ${print(e.right)})`;
  }
}
/** Without the outer parentheses. */
export const printTop = (e: Expr) => { const s = print(e); return e.kind === "leaf" ? s : s.slice(1, -1); };

/* ---------------- the parser, with a trace ---------------- */

export type Event =
  | { type: "call"; depth: number; minBp: number; at: number }
  | { type: "operand"; depth: number; node: Expr; at: number }
  | { type: "decide"; depth: number; op: string; bp: number | null; minBp: number; bind: boolean; rightBp?: number; at: number }
  | { type: "build"; depth: number; node: Expr; at: number }
  | { type: "return"; depth: number; node: Expr; at: number }
  | { type: "error"; depth: number; message: string; at: number };

export interface ParseResult { tree: Expr | null; events: Event[]; tokens: Token[]; error: string | null; comparisons: number; maxDepth: number }

class ParseError extends Error {}

export function parse(src: string, table: Row[] = DEFAULT_TABLE): ParseResult {
  const tokens = lex(src).tokens;
  const events: Event[] = [];
  let pos = 0, id = 0, comparisons = 0, maxDepth = 0;
  const peek = () => tokens[pos];
  const fail = (depth: number, message: string): never => {
    events.push({ type: "error", depth, message, at: pos });
    throw new ParseError(message);
  };

  const expr = (minBp: number, depth: number): Expr => {
    maxDepth = Math.max(maxDepth, depth + 1);
    events.push({ type: "call", depth, minBp, at: pos });
    let left = prefix(depth);
    for (;;) {
      const t = peek();
      if (t.kind === "eof" || t.text === ")") {
        events.push({ type: "decide", depth, op: t.kind === "eof" ? "end" : ")", bp: null, minBp, bind: false, at: pos });
        break;
      }
      const row = rowOf(table, t);
      if (!row) fail(depth, `${t.line}:${t.col}: expected an operator, got ${t.kind === "error" ? t.message : `'${t.text}'`}`);
      comparisons++;
      const bind = row!.bp > minBp;
      const rightBp = row!.assoc === "left" ? row!.bp : row!.bp - 1;
      events.push({ type: "decide", depth, op: t.text, bp: row!.bp, minBp, bind, rightBp: bind ? rightBp : undefined, at: pos });
      if (!bind) break;
      pos++;
      const right = expr(rightBp, depth + 1);
      left = { id: ++id, kind: "binary", op: t.text, left, right };
      events.push({ type: "build", depth, node: left, at: pos });
    }
    events.push({ type: "return", depth, node: left, at: pos });
    return left;
  };

  const prefix = (depth: number): Expr => {
    const t = peek();
    if (t.kind === "error") fail(depth, `${t.line}:${t.col}: ${t.message}`);
    if (t.text === "(" && t.kind === "op") {
      pos++;
      const inner = expr(0, depth + 1);
      if (peek().text !== ")") fail(depth, `${peek().line}:${peek().col}: expected ')'`);
      pos++;
      return inner;
    }
    if ((t.kind === "op" || t.kind === "keyword") && t.text in PREFIX_BP) {
      pos++;
      const x = expr(PREFIX_BP[t.text], depth + 1);
      const node: Expr = { id: ++id, kind: "unary", op: t.text, x };
      events.push({ type: "build", depth, node, at: pos });
      return node;
    }
    if (t.kind === "ident" || t.kind === "number" || t.kind === "string" || (t.kind === "keyword" && (t.text === "true" || t.text === "false"))) {
      pos++;
      const node: Expr = { id: ++id, kind: "leaf", tok: t };
      events.push({ type: "operand", depth, node, at: pos });
      return node;
    }
    return fail(depth, t.kind === "eof" ? "unexpected end of rule: expected an operand" : `${t.line}:${t.col}: expected an operand, got '${t.text}'`);
  };

  try {
    const tree = expr(0, 0);
    if (peek().kind !== "eof") fail(0, `${peek().line}:${peek().col}: unexpected '${peek().text}'`);
    return { tree, events, tokens, error: null, comparisons, maxDepth };
  } catch (e) {
    if (e instanceof ParseError) return { tree: null, events, tokens, error: e.message, comparisons, maxDepth };
    throw e;
  }
}

/* ---------------- evaluating the tree for one host ---------------- */

export type Value = number | string | boolean;
export const HOST: Record<string, Value> = { cpu: 0.97, mem: 0.5, env: "staging", errors: 30, requests: 400, retries: 6, timeouts: 4, p99: 250 };

export function evaluate(e: Expr, env: Record<string, Value> = HOST): { value: Value | null; error: string | null } {
  const ev = (n: Expr): Value => {
    if (n.kind === "leaf") {
      const t = n.tok;
      if (t.kind === "number") return Number(t.text);
      if (t.kind === "string") return t.text.slice(1, -1);
      if (t.kind === "keyword") return t.text === "true";
      if (!(t.text in env)) throw new Error(`unknown metric ${t.text}`);
      return env[t.text];
    }
    if (n.kind === "unary") {
      const x = ev(n.x);
      if (n.op === "not") { if (typeof x !== "boolean") throw new Error(`not needs a boolean, got ${JSON.stringify(x)}`); return !x; }
      if (typeof x !== "number") throw new Error(`- needs a number, got ${JSON.stringify(x)}`);
      return -x;
    }
    const a = ev(n.left);
    if (n.op === "and" || n.op === "or") {
      if (typeof a !== "boolean") throw new Error(`${n.op} needs booleans, got ${JSON.stringify(a)}`);
      if (n.op === "and" ? !a : a) return a;
      const b = ev(n.right);
      if (typeof b !== "boolean") throw new Error(`${n.op} needs booleans, got ${JSON.stringify(b)}`);
      return b;
    }
    const b = ev(n.right);
    if (n.op === "==") return a === b;
    if (n.op === "!=") return a !== b;
    if (typeof a !== "number" || typeof b !== "number") throw new Error(`${n.op} needs numbers, got ${JSON.stringify(a)} ${n.op} ${JSON.stringify(b)}`);
    switch (n.op) {
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? (() => { throw new Error("division by zero"); })() : a / b;
    }
    throw new Error(`unknown operator ${n.op}`);
  };
  try { return { value: ev(e), error: null }; } catch (err) { return { value: null, error: (err as Error).message }; }
}

/** Depth of the tree (a leaf is 1). */
export const height = (e: Expr): number => e.kind === "leaf" ? 1 : e.kind === "unary" ? 1 + height(e.x) : 1 + Math.max(height(e.left), height(e.right));

/* ---------------- presets, challenges, state ---------------- */

export const PRESETS = [
  { label: "Mixed and/or", src: 'cpu > 0.95 or mem > 0.9 and env == "prod"' },
  { label: "Ratio", src: "errors / requests > 0.05 and not env == \"dev\"" },
  { label: "Minus chain", src: "requests - retries - timeouts" },
  { label: "Unary and parens", src: "-p99 < -200 or (cpu > 0.9 or mem > 0.9) and env == \"prod\"" },
];

export type Goal = "flip" | "assoc" | "broken";
export const GOALS: { id: Goal; text: string }[] = [
  { id: "flip", text: "Mixed and/or: make the staging host stop paging by changing one binding power." },
  { id: "assoc", text: "Minus chain: make - right-associative and compare the result with the left-associative one." },
  { id: "broken", text: "Break it: give comparisons a lower power than and, and parse Mixed and/or." },
];

export interface State {
  src: string;
  table: Row[];
  /** Events revealed by stepping. */
  shown: number;
  /** Table edits made by the reader. */
  edits: number;
  /** Distinct trees seen for each source, printed. */
  trees: Record<string, string[]>;
  /** How many times an edit flipped the evaluated result for the current rule. */
  flips: number;
  goals: Record<Goal, boolean>;
}

export type Action =
  | { type: "preset"; index: number }
  | { type: "edit"; src: string }
  | { type: "bp"; key: RowKey; delta: 1 | -1 }
  | { type: "assoc"; key: RowKey }
  | { type: "step" }
  | { type: "run" }
  | { type: "back" }
  | { type: "reset" };

const cloneTable = () => DEFAULT_TABLE.map((r) => ({ ...r, ops: [...r.ops] }));

export function init(): State {
  return record({ src: PRESETS[0].src, table: cloneTable(), shown: 0, edits: 0, trees: {}, flips: 0, goals: { flip: false, assoc: false, broken: false } });
}

const resultKey = (st: { src: string; table: Row[] }) => {
  const r = parse(st.src, st.table);
  if (!r.tree) return "parse error";
  const v = evaluate(r.tree);
  return v.error ? "error" : String(v.value);
};

/** Remember the tree this table makes for this source, and update the goals. */
function record(st: State): State {
  const r = parse(st.src, st.table);
  const trees = { ...st.trees };
  if (r.tree) {
    const p = printTop(r.tree);
    const seen = trees[st.src] ?? [];
    if (!seen.includes(p)) trees[st.src] = [...seen, p];
  }
  const g = { ...st.goals };
  const val = r.tree ? evaluate(r.tree) : null;
  if (st.src === PRESETS[0].src && r.tree?.kind === "binary" && r.tree.op === "and" && val?.value === false) g.flip = true;
  if (st.src === PRESETS[2].src && (trees[st.src]?.length ?? 0) >= 2 && st.table.find((x) => x.key === "add")!.assoc === "right") g.assoc = true;
  const bp = (k: RowKey) => st.table.find((x) => x.key === k)!.bp;
  if (st.src === PRESETS[0].src && bp("cmp") < bp("and") && r.tree && val?.error) g.broken = true;
  return { ...st, trees, goals: g };
}

export function step(st: State, a: Action): State {
  const total = parse(st.src, st.table).events.length;
  switch (a.type) {
    case "reset":
      return init();
    case "preset":
      return record({ ...st, src: PRESETS[a.index].src, shown: 0 });
    case "edit":
      return record({ ...st, src: a.src, shown: 0 });
    case "bp":
    case "assoc": {
      const table = st.table.map((r) => r.key !== a.key ? r
        : a.type === "bp" ? { ...r, bp: Math.min(BP_MAX, Math.max(BP_MIN, r.bp + a.delta)) }
        : { ...r, assoc: r.assoc === "left" ? "right" as const : "left" as const });
      if (table.every((r, i) => r.bp === st.table[i].bp && r.assoc === st.table[i].assoc)) return st;
      const before = resultKey(st);
      const next: State = { ...st, table, edits: st.edits + 1 };
      const after = resultKey(next);
      const shown = Math.min(st.shown, parse(st.src, table).events.length);
      return record({ ...next, shown, flips: st.flips + (before !== after ? 1 : 0) });
    }
    case "step":
      return st.shown >= total ? st : { ...st, shown: st.shown + 1 };
    case "run":
      return { ...st, shown: total };
    case "back":
      return { ...st, shown: Math.max(0, st.shown - 1) };
  }
}

/** The call frames still open after `shown` events: their min binding power and depth. */
export function frames(events: Event[], shown: number): { depth: number; minBp: number }[] {
  const stack: { depth: number; minBp: number }[] = [];
  for (const e of events.slice(0, shown)) {
    if (e.type === "call") stack.push({ depth: e.depth, minBp: e.minBp });
    if (e.type === "return") stack.pop();
  }
  return stack;
}

/** Ids of nodes built after `shown` events. */
export function builtIds(events: Event[], shown: number): Set<number> {
  const s = new Set<number>();
  for (const e of events.slice(0, shown)) if (e.type === "operand" || e.type === "build") s.add(e.node.id);
  return s;
}

/** One-line explanation of an event. */
export function explain(e: Event): string {
  switch (e.type) {
    case "call": return `parseExpr(${e.minBp}): parse an operand, then take operators while their power is above ${e.minBp}.`;
    case "operand": return `Read the operand ${printTop(e.node)}.`;
    case "decide":
      if (e.bp === null) return e.op === "end" ? "End of the rule: nothing more to take, return what we have." : "A ')' closes the group: return what we have.";
      return e.bind
        ? `'${e.op}' has power ${e.bp} > ${e.minBp}: it binds. It takes the left side, and parses its right side with parseExpr(${e.rightBp})${e.rightBp === e.bp ? ", so an equal power will stop there (left-associative)" : ", one lower, so an equal power keeps going (right-associative)"}.`
        : `'${e.op}' has power ${e.bp}, not above ${e.minBp}: too weak to take this left side. Return it to the caller, which may let '${e.op}' bind there.`;
    case "build": return `Build ${print(e.node)}.`;
    case "return": return `Return ${printTop(e.node)} to the caller.`;
    case "error": return `Parse error: ${e.message}.`;
  }
}
