// Interpreter playground: a feature-flag targeting rule as a tree of expression nodes.
//
// After this, the reader can answer: how does a rule written as a tree of small expression
// objects get evaluated (each node asks its children, the leaves read the user), and why does
// that turn a targeting change from a code change and deploy into a data change?
//
// The reader edits the tree directly (flip AND/OR, negate, change values), picks a user to trace
// the evaluation node by node (with short-circuiting), works through targeting requests from
// sales, and tries to save a rule that compares text with a number. Two more interpretations of
// the same tree run alongside: print (rule as text) and check (types).
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Attr = "country" | "plan" | "seats" | "optOut";
export interface User { name: string; country: string; plan: string; seats: number; optOut: boolean }

export type Node =
  | { id: number; kind: "and" | "or"; kids: Node[] }
  | { id: number; kind: "not"; kid: Node }
  | { id: number; kind: "in"; attr: Attr; values: string[] }
  | { id: number; kind: "eq"; attr: Attr; value: string | boolean }
  | { id: number; kind: "gte"; attr: Attr; n: number };

export const USERS: User[] = [
  { name: "Lena", country: "DE", plan: "pro", seats: 12, optOut: false },
  { name: "Marc", country: "FR", plan: "free", seats: 80, optOut: false },
  { name: "Aiko", country: "JP", plan: "pro", seats: 60, optOut: false },
  { name: "Sam", country: "US", plan: "pro", seats: 200, optOut: false },
  { name: "Jonas", country: "DE", plan: "team", seats: 55, optOut: true },
  { name: "Chloé", country: "FR", plan: "pro", seats: 300, optOut: false },
  { name: "Kenji", country: "JP", plan: "free", seats: 5, optOut: false },
  { name: "Priya", country: "US", plan: "team", seats: 40, optOut: false },
  { name: "Hugo", country: "FR", plan: "team", seats: 8, optOut: false },
  { name: "Yuki", country: "JP", plan: "team", seats: 120, optOut: false },
];

const ATTR_TYPE: Record<Attr, "text" | "number" | "bool"> = { country: "text", plan: "text", seats: "number", optOut: "bool" };

export function initialRule(): Node {
  return {
    id: 1, kind: "and", kids: [
      { id: 2, kind: "in", attr: "country", values: ["DE", "FR"] },
      { id: 3, kind: "or", kids: [{ id: 4, kind: "eq", attr: "plan", value: "pro" }, { id: 5, kind: "gte", attr: "seats", n: 50 }] },
      { id: 6, kind: "not", kid: { id: 7, kind: "eq", attr: "optOut", value: true } },
    ],
  };
}

/* ---------------- interpretation 1: evaluate ---------------- */

export type Mark = boolean | "skipped" | "error";
export interface EvalResult { value: boolean | "error"; marks: Record<number, Mark>; evaluated: number; error: string | null }

class EvalError extends Error {}

/** Tree-walking evaluation with short-circuit AND/OR. Records every node's outcome. */
export function evaluate(root: Node, u: User): EvalResult {
  const marks: Record<number, Mark> = {};
  let evaluated = 0;
  const skip = (n: Node) => { marks[n.id] = "skipped"; if (n.kind === "and" || n.kind === "or") n.kids.forEach(skip); if (n.kind === "not") skip(n.kid); };
  const ev = (n: Node): boolean => {
    evaluated++;
    let v: boolean;
    switch (n.kind) {
      case "and":
      case "or": {
        const stopOn = n.kind === "or";
        v = !stopOn;
        let i = 0;
        for (; i < n.kids.length; i++) {
          if (ev(n.kids[i]) === stopOn) { v = stopOn; i++; break; }
        }
        n.kids.slice(i).forEach(skip);
        break;
      }
      case "not":
        v = !ev(n.kid);
        break;
      case "in":
        v = n.values.includes(String(u[n.attr]));
        break;
      case "eq":
        v = u[n.attr] === n.value;
        break;
      case "gte": {
        const x = u[n.attr];
        if (typeof x !== "number") { marks[n.id] = "error"; throw new EvalError(`cannot compare ${n.attr} "${x}" with ${n.n}`); }
        v = x >= n.n;
        break;
      }
    }
    marks[n.id] = v;
    return v;
  };
  try {
    return { value: ev(root), marks, evaluated, error: null };
  } catch (e) {
    if (e instanceof EvalError) return { value: "error", marks, evaluated, error: e.message };
    throw e;
  }
}

/* ---------------- interpretation 2: print ---------------- */

export function print(n: Node, top = true): string {
  switch (n.kind) {
    case "and":
    case "or": {
      const s = n.kids.map((k) => print(k, false)).join(` ${n.kind} `);
      return top ? s : `(${s})`;
    }
    case "not": return `not ${print(n.kid, false)}`;
    case "in": return `${n.attr} in [${n.values.join(", ")}]`;
    case "eq": return typeof n.value === "boolean" ? (n.value ? n.attr : `not ${n.attr}`) : `${n.attr} = ${n.value}`;
    case "gte": return `${n.attr} >= ${n.n}`;
  }
}

/* ---------------- interpretation 3: check ---------------- */

export function check(n: Node): string[] {
  switch (n.kind) {
    case "and":
    case "or": return n.kids.flatMap(check);
    case "not": return check(n.kid);
    case "gte": return ATTR_TYPE[n.attr] === "number" ? [] : [`${n.attr} is ${ATTR_TYPE[n.attr]}, so ${n.attr} >= ${n.n} can never be evaluated`];
    default: return [];
  }
}

export const count = (n: Node): number => 1 + (n.kind === "and" || n.kind === "or" ? n.kids.reduce((s, k) => s + count(k), 0) : n.kind === "not" ? count(n.kid) : 0);

/* ---------------- tasks ---------------- */

export interface Task { title: string; ask: string; target: string[] | null }
export const TASKS: Task[] = [
  { title: "Launch in Japan too", ask: "Sales wants the same targeting in Japan. Make the rule match Lena, Marc, Chloé, Aiko and Yuki.", target: ["Lena", "Marc", "Chloé", "Aiko", "Yuki"] },
  { title: "Big pro accounts only", ask: "Now only pro customers with at least 50 seats, in the same three countries. Make it match Aiko and Chloé.", target: ["Aiko", "Chloé"] },
  { title: "Break it", ask: "Change the seats comparison to read a text attribute instead, and try to save.", target: null },
];

/* ---------------- state and step ---------------- */

export interface State {
  rule: Node;
  saved: Node;
  nextId: number;
  user: string | null;
  edits: number;
  saves: number;
  rejected: number;
  task: number;
  done: boolean[];
  message: string | null;
}

export type Action =
  | { type: "flip"; id: number }
  | { type: "negate"; id: number }
  | { type: "cycle"; id: number }
  | { type: "attr"; id: number }
  | { type: "pick"; user: string }
  | { type: "save" }
  | { type: "nextTask" }
  | { type: "reset" };

export function init(): State {
  const r = initialRule();
  return { rule: r, saved: r, nextId: 8, user: null, edits: 0, saves: 0, rejected: 0, task: 0, done: [false, false, false], message: null };
}

const IN_SETS = [["DE", "FR"], ["DE", "FR", "JP"], ["JP"], ["US"]];
const PLANS = ["pro", "team", "free"];
const SEATS = [50, 10, 200];

/** Replace the node with this id by f(node). */
function edit(n: Node, id: number, f: (n: Node) => Node): Node {
  if (n.id === id) return f(n);
  if (n.kind === "and" || n.kind === "or") return { ...n, kids: n.kids.map((k) => edit(k, id, f)) };
  if (n.kind === "not") return { ...n, kid: edit(n.kid, id, f) };
  return n;
}

export const matches = (rule: Node) => USERS.filter((u) => evaluate(rule, u).value === true).map((u) => u.name);
export const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function afterEdit(st: State, rule: Node, nextId = st.nextId): State {
  const next = { ...st, rule, nextId, edits: st.edits + 1, message: null };
  const t = TASKS[st.task];
  if (t?.target && sameSet(matches(rule), t.target) && !st.done[st.task]) next.done = st.done.map((d, i) => (i === st.task ? true : d));
  return next;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "pick":
      return { ...st, user: st.user === a.user ? null : a.user };
    case "flip":
      return afterEdit(st, edit(st.rule, a.id, (n) => (n.kind === "and" ? { ...n, kind: "or" } : n.kind === "or" ? { ...n, kind: "and" } : n)));
    case "negate": {
      // Wrap the node in NOT, or unwrap it if it already is one. The root cannot be unwrapped away.
      let id = st.nextId;
      const rule = edit(st.rule, a.id, (n) => (n.kind === "not" ? n.kid : { id: id++, kind: "not", kid: n }));
      return afterEdit(st, rule, id);
    }
    case "cycle":
      return afterEdit(st, edit(st.rule, a.id, (n) => {
        if (n.kind === "in") { const i = IN_SETS.findIndex((s) => sameSet(s, n.values)); return { ...n, values: IN_SETS[(i + 1) % IN_SETS.length] }; }
        if (n.kind === "eq" && n.attr === "plan") return { ...n, value: PLANS[(PLANS.indexOf(String(n.value)) + 1) % PLANS.length] };
        if (n.kind === "eq" && typeof n.value === "boolean") return { ...n, value: !n.value };
        if (n.kind === "gte") return { ...n, n: SEATS[(SEATS.indexOf(n.n) + 1) % SEATS.length] };
        return n;
      }));
    case "attr":
      return afterEdit(st, edit(st.rule, a.id, (n) => (n.kind === "gte" ? { ...n, attr: n.attr === "seats" ? "country" : "seats" } : n)));
    case "save": {
      const errors = check(st.rule);
      if (errors.length) {
        const done = st.task === 2 ? st.done.map((d, i) => (i === 2 ? true : d)) : st.done;
        return { ...st, rejected: st.rejected + 1, done, message: `Not saved: ${errors[0]}.` };
      }
      return { ...st, saved: st.rule, saves: st.saves + 1, message: "Saved. Every flag check uses the new rule from the next request. No build, no deploy." };
    }
    case "nextTask":
      return st.task < TASKS.length - 1 && st.done[st.task] ? { ...st, task: st.task + 1, message: null } : st;
  }
}

/** Nodes visited to evaluate the rule for every user, with short-circuiting, and without. */
export function cost(rule: Node): { lazy: number; eager: number } {
  return { lazy: USERS.reduce((s, u) => s + evaluate(rule, u).evaluated, 0), eager: USERS.length * count(rule) };
}
