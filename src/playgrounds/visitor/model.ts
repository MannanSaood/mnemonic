// Visitor playground: an infrastructure-as-code tool with resource types (network, database,
// bucket, load balancer) and operations over a stack of them (validate, render). The same code
// cells, one per (operation, resource type), are laid out two ways side by side:
//   methods: each resource type is a file holding all its operations (cells grouped by column)
//   visitor: each operation is a visitor file holding one method per resource type (grouped by row)
//
// After this, the reader can answer: why does Visitor make adding an operation touch no existing
// file, and adding a resource type touch every visitor, and how does a call find the right cell?
//
// Request 1 adds an operation (cost estimate). Request 2 adds a resource type (queue).
// Break it: give the visitors a base with empty defaults. Missing cells then compile, and the
// queue is silently costed at $0 and left out of the plan.
// Plain state + a pure step function, so it can be tested without a browser.

export type Design = "methods" | "visitor";
export type Res = "network" | "database" | "bucket" | "lb" | "queue";
export type Op = "validate" | "render" | "cost";

export const DESIGNS: Design[] = ["methods", "visitor"];
export const RES_NAME: Record<Res, string> = { network: "Network", database: "Database", bucket: "Bucket", lb: "LoadBalancer", queue: "Queue" };
export const OP_NAME: Record<Op, string> = { validate: "Validate", render: "Render", cost: "Cost" };
/** The stack the operations run over: one resource of each type, the network holding the rest. */
export const STACK: { res: Res; id: string; monthly: number }[] = [
  { res: "network", id: "prod-vpc", monthly: 33 },
  { res: "database", id: "orders-db", monthly: 412 },
  { res: "bucket", id: "invoices", monthly: 23 },
  { res: "lb", id: "api-lb", monthly: 18 },
  { res: "queue", id: "emails-queue", monthly: 4 },
];

export const cell = (op: Op, res: Res) => `${op}:${res}`;
/** The file a cell lives in, per design. */
export function fileOf(d: Design, op: Op, res: Res): string {
  return d === "methods" ? `${res}` : `${op} visitor`;
}

export interface Side {
  cells: string[];
  /** visitor design: the Visitor interface declares VisitQueue */
  iface: boolean;
  /** visitor design: a base visitor with empty default visits (break-it) */
  defaults: boolean;
  /** files edited and created during the current request */
  edited: string[];
  created: string[];
}

export interface RequestResult { methods: { edited: number; created: number; cells: number }; visitor: { edited: number; created: number; cells: number } }

export interface State {
  request: 0 | 1 | 2; // 0: add cost, 1: add queue, 2: summary
  methods: Side;
  visitor: Side;
  results: RequestResult[];
  predictions: Record<number, string | null>;
  /** the resource whose call is traced */
  trace: Res;
}

export type Action =
  | { type: "write"; design: Design; op: Op; res: Res }
  | { type: "declareQueue" }                 // visitor: add VisitQueue to the Visitor interface
  | { type: "toggleDefaults" }               // visitor: base visitor with empty defaults
  | { type: "trace"; res: Res }
  | { type: "next" }
  | { type: "predict"; request: number; value: string }
  | { type: "reset" };

const BASE_RES: Res[] = ["network", "database", "bucket", "lb"];
const BASE_OPS: Op[] = ["validate", "render"];

export function types(st: State): Res[] { return st.request >= 1 ? [...BASE_RES, "queue"] : BASE_RES; }
export function ops(_st: State): Op[] { return [...BASE_OPS, "cost"]; }

function side(): Side {
  const cells = BASE_OPS.flatMap((op) => BASE_RES.map((r) => cell(op, r)));
  return { cells, iface: false, defaults: false, edited: [], created: [] };
}

export function init(): State {
  return { request: 0, methods: side(), visitor: side(), results: [], predictions: {}, trace: "database" };
}

/** Files that exist before the current request starts. */
function existed(st: State, d: Design, file: string): boolean {
  if (d === "methods") return BASE_RES.includes(file as Res) || (st.request >= 2 && file === "queue");
  if (file === "visitor interface") return true;
  if (file === "cost visitor") return st.request >= 1;
  return file === "validate visitor" || file === "render visitor";
}

function touch(st: State, d: Design, s: Side, file: string): Side {
  if (existed(st, d, file)) return s.edited.includes(file) ? s : { ...s, edited: [...s.edited, file] };
  return s.created.includes(file) ? s : { ...s, created: [...s.created, file] };
}

export interface Issue { text: string; silent: boolean }

/** Build the design: compile errors (silent: false) and silent wrong results (silent: true). */
export function build(st: State, d: Design): Issue[] {
  const s = st[d];
  const out: Issue[] = [];
  if (d === "visitor" && st.request >= 1 && !s.iface)
    out.push({ text: "Queue.Accept calls v.VisitQueue, but the Visitor interface has no such method", silent: false });
  for (const op of ops(st)) for (const r of types(st)) {
    if (s.cells.includes(cell(op, r))) continue;
    if (d === "methods") out.push({ text: `${RES_NAME[r]} does not implement Resource: missing ${OP_NAME[op]}`, silent: false });
    else if (s.defaults) out.push({ text: SILENT[op](r), silent: true });
    else out.push({ text: `${OP_NAME[op]}Visitor does not implement Visitor: missing Visit${RES_NAME[r]}`, silent: false });
  }
  return out;
}

const idOf = (r: Res) => STACK.find((x) => x.res === r)!.id;
const SILENT: Record<Op, (r: Res) => string> = {
  cost: (r) => `${idOf(r)} costed at $0 by the empty default`,
  render: (r) => `${idOf(r)} left out of the plan, so it is never deployed`,
  validate: (r) => `${idOf(r)} never validated`,
};

export const compiles = (st: State, d: Design) => build(st, d).every((i) => i.silent);

/** The cost estimate the design prints, or null if it does not build. */
export function estimate(st: State, d: Design): number | null {
  if (!compiles(st, d)) return null;
  return STACK.filter((x) => types(st).includes(x.res) && st[d].cells.includes(cell("cost", x.res))).reduce((n, x) => n + x.monthly, 0);
}

export function trueEstimate(st: State): number {
  return STACK.filter((x) => types(st).includes(x.res)).reduce((n, x) => n + x.monthly, 0);
}

/** The hops one Cost call takes for a resource. */
export function traceOf(st: State, d: Design, r: Res): { hops: string[]; ok: boolean; note: string } {
  const id = idOf(r), name = RES_NAME[r];
  const has = st[d].cells.includes(cell("cost", r));
  if (!types(st).includes(r)) return { hops: [], ok: false, note: `There is no ${name} type yet.` };
  if (d === "methods") {
    return has
      ? { hops: [`${id}.Cost()`, `${name}.Cost`, "✓"], ok: true, note: "One dispatch, on the resource's type." }
      : { hops: [`${id}.Cost()`, "✗"], ok: false, note: `${name} has no Cost method yet.` };
  }
  const head = [`${id}.Accept(cost)`, `${name}.Accept`];
  if (has) return { hops: [...head, `cost.Visit${name}(${id})`, `CostVisitor.Visit${name}`, "✓"], ok: true, note: "Two dispatches: Accept picks by the resource's type, then Visit picks by the visitor's type." };
  if (st.visitor.defaults) return { hops: [...head, `cost.Visit${name}(${id})`, "BaseVisitor default", "$0"], ok: false, note: "The call lands in the empty default and returns nothing." };
  return { hops: [...head, "✗"], ok: false, note: `CostVisitor has no Visit${name} yet.` };
}

/** Everything the current request needs is in place, with no silent gaps. */
export function sideDone(st: State, d: Design): boolean {
  return build(st, d).length === 0;
}
export const requestDone = (st: State) => sideDone(st, "methods") && sideDone(st, "visitor");

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "predict":
      return { ...st, predictions: { ...st.predictions, [a.request]: a.value } };

    case "trace":
      return { ...st, trace: a.res };

    case "write": {
      if (st.request >= 2 || !types(st).includes(a.res)) return st;
      const s = st[a.design];
      const c = cell(a.op, a.res);
      if (s.cells.includes(c)) return st;
      let next: Side = { ...s, cells: [...s.cells, c] };
      next = touch(st, a.design, next, fileOf(a.design, a.op, a.res));
      return { ...st, [a.design]: next };
    }

    case "declareQueue": {
      if (st.request !== 1 || st.visitor.iface) return st;
      const s = touch(st, "visitor", { ...st.visitor, iface: true }, "visitor interface");
      return { ...st, visitor: s };
    }

    case "toggleDefaults": {
      if (st.request >= 2) return st;
      // A break-it switch, not part of the request's work, so it is not counted as an edit.
      return { ...st, visitor: { ...st.visitor, defaults: !st.visitor.defaults } };
    }

    case "next": {
      if (st.request >= 2 || !requestDone(st)) return st;
      const res = (d: Design) => ({ edited: st[d].edited.length, created: st[d].created.length, cells: st[d].cells.length - (st.request === 0 ? 8 : 12) });
      const results = [...st.results, { methods: res("methods"), visitor: res("visitor") }];
      const request = (st.request + 1) as 1 | 2;
      const clear = (s: Side, d: Design): Side => ({
        ...s, edited: [], created: request === 1 && d === "visitor" ? ["queue"] : [],
      });
      return { ...st, request, results, methods: clear(st.methods, "methods"), visitor: clear(st.visitor, "visitor"), trace: request === 1 ? "queue" : st.trace };
    }
  }
}
