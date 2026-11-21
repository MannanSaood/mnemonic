// References-and-GC playground: run a short program line by line and watch names, objects,
// reference counts and the cycle collector, drawn like Python Tutor's heap diagrams.
//
// Purpose. After this, the reader can answer: "When I assign, pass or store something in
// Python, do I get a new object or a new reference to the same one, and when is the object
// freed?" Assignment binds a name; it never copies. An object is freed the moment its
// reference count reaches zero, except when it is part of a cycle: then only the cycle
// collector can free it.
//
// Three programs, each with the code as written and the fixed code:
//   defaults  a mutable default argument shared by every call (the invoice recipients bug)
//   rota      [[...] * 3] * 3: three rows that are one list
//   cycle     run.on_error = run.log_failure: an object that keeps itself alive
// Plus a loop that runs the nightly job 50 times and measures memory held by dead cycles,
// with the collector on or off.
//
// Plain state + a pure step function, so it can be tested without a browser. The heap is
// rebuilt by replaying the program's lines, so every state is reproducible.

export type ProgId = "defaults" | "rota" | "cycle";
export const PROGS: ProgId[] = ["defaults", "rota", "cycle"];

/** A slot holds a plain value (drawn inline) or a reference to a heap object. */
export type Val = { ref: number; weak?: boolean } | { text: string };
export interface Slot { key: string; v: Val }
export interface Obj { id: number; type: string; slots: Slot[]; mb?: number }
export interface Freed { id: number; type: string; by: "refcount" | "gc" }
export interface Heap {
  names: { name: string; to: number }[];
  objs: Record<number, Obj>;
  next: number;
  freed: Freed[];
}

export interface Line { code: string; note: string; result?: string; run: (h: Heap) => void }

/* ---------------- heap primitives (used on a fresh copy while replaying) ---------------- */

function alloc(h: Heap, type: string, slots: Slot[] = [], mb?: number): number {
  const id = h.next++;
  h.objs[id] = { id, type, slots, ...(mb ? { mb } : {}) };
  return id;
}
function bind(h: Heap, name: string, to: number) {
  const n = h.names.find((x) => x.name === name);
  if (n) n.to = to; else h.names.push({ name, to });
}
function unbind(h: Heap, name: string) {
  h.names = h.names.filter((x) => x.name !== name);
}
const nameTo = (h: Heap, name: string) => h.names.find((x) => x.name === name)!.to;
const ref = (id: number, weak = false): Val => (weak ? { ref: id, weak } : { ref: id });
const txt = (text: string): Val => ({ text });
const isRef = (v: Val): v is { ref: number; weak?: boolean } => "ref" in v;

/** Strong references to an object: from names, and from slots of live objects. Weak ones do not count. */
export function refcount(h: Heap, id: number): number {
  let n = h.names.filter((x) => x.to === id).length;
  for (const o of Object.values(h.objs)) for (const s of o.slots) if (isRef(s.v) && s.v.ref === id && !s.v.weak) n++;
  return n;
}

/** What reference counting does after every statement: free anything whose count is zero, and repeat. */
function reclaim(h: Heap) {
  for (;;) {
    const dead = Object.values(h.objs).filter((o) => refcount(h, o.id) === 0);
    if (!dead.length) return;
    for (const o of dead) {
      delete h.objs[o.id];
      h.freed.push({ id: o.id, type: o.type, by: "refcount" });
    }
    // a weak reference to a freed object goes dead (it reads as None)
    for (const o of Object.values(h.objs)) o.slots = o.slots.map((s) => (isRef(s.v) && !h.objs[s.v.ref] ? { ...s, v: txt("dead → None") } : s));
  }
}

/** Objects reachable from names through strong references. */
export function reachable(h: Heap): Set<number> {
  const seen = new Set<number>();
  const todo = h.names.map((n) => n.to);
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id) || !h.objs[id]) continue;
    seen.add(id);
    for (const s of h.objs[id].slots) if (isRef(s.v) && !s.v.weak) todo.push(s.v.ref);
  }
  return seen;
}

/** gc.collect(): free every object that no name can reach, even though its count is above zero. */
function collect(h: Heap) {
  const live = reachable(h);
  for (const o of Object.values(h.objs)) {
    if (live.has(o.id)) continue;
    delete h.objs[o.id];
    h.freed.push({ id: o.id, type: o.type, by: "gc" });
  }
}

/* ---------------- the programs ---------------- */

export const PDF_MB = 40;

export interface Program { title: string; lines: Record<"bug" | "fixed", Line[]>; ask: number }

export const PROGRAMS: Record<ProgId, Program> = {
  defaults: {
    title: "Mutable default",
    ask: 3,
    lines: {
      bug: [
        {
          code: 'def recipients(email, cc=[]):\n    cc.append(email)\n    return cc',
          note: "def runs once. The default list is created now and stored on the function object, in __defaults__.",
          run: (h) => { const d = alloc(h, "list"); bind(h, "recipients", alloc(h, "function recipients", [{ key: "__defaults__[0]", v: ref(d) }])); },
        },
        {
          code: 'a = recipients("ana@shop.io")',
          note: "Inside the call, cc names the default list. append changes that list, and return hands back the same list.",
          run: (h) => { const d = (h.objs[nameTo(h, "recipients")].slots[0].v as { ref: number }).ref; h.objs[d].slots.push({ key: "0", v: txt("'ana@shop.io'") }); bind(h, "a", d); },
        },
        {
          code: 'b = recipients("ben@shop.io")',
          note: "The same default list again. Ben's invoice goes to Ana too, and a now holds both addresses.",
          run: (h) => { const d = nameTo(h, "a"); h.objs[d].slots.push({ key: "1", v: txt("'ben@shop.io'") }); bind(h, "b", d); },
        },
        {
          code: "a is b",
          result: "True",
          note: "One list with three references: a, b and the function's __defaults__. Nothing was ever copied.",
          run: () => {},
        },
      ],
      fixed: [
        {
          code: 'def recipients(email, cc=None):\n    to = [] if cc is None else list(cc)\n    to.append(email)\n    return to',
          note: "The default is None, which is immutable and safe to share. The list is made inside the body, on every call.",
          run: (h) => { bind(h, "recipients", alloc(h, "function recipients", [{ key: "__defaults__[0]", v: txt("None") }])); },
        },
        {
          code: 'a = recipients("ana@shop.io")',
          note: "A new list, created by this call. When the call returns, a is its only reference.",
          run: (h) => { bind(h, "a", alloc(h, "list", [{ key: "0", v: txt("'ana@shop.io'") }])); },
        },
        {
          code: 'b = recipients("ben@shop.io")',
          note: "Another new list. Ben's invoice goes to Ben.",
          run: (h) => { bind(h, "b", alloc(h, "list", [{ key: "0", v: txt("'ben@shop.io'") }])); },
        },
        { code: "a is b", result: "False", note: "Two lists, one reference each.", run: () => {} },
      ],
    },
  },
  rota: {
    title: "Nested lists",
    ask: 2,
    lines: {
      bug: [
        {
          code: 'rota = [["-"] * 3] * 3   # 3 days × 3 shifts',
          note: "The inner list is built once. * 3 on the outer list copies the reference three times, not the list.",
          run: (h) => { const row = alloc(h, "list", ["0", "1", "2"].map((k) => ({ key: k, v: txt("'-'") }))); bind(h, "rota", alloc(h, "list", ["0", "1", "2"].map((k) => ({ key: k, v: ref(row) })))); },
        },
        {
          code: 'rota[0][0] = "ana"       # Monday, early shift',
          note: "rota[0] is the one row list, so every day now starts with ana.",
          run: (h) => { const row = (h.objs[nameTo(h, "rota")].slots[0].v as { ref: number }).ref; h.objs[row].slots[0].v = txt("'ana'"); },
        },
        {
          code: 'rota[2][2] = "ben"       # Wednesday, night shift',
          note: "Ben is now on nights every day, through the same row.",
          run: (h) => { const row = (h.objs[nameTo(h, "rota")].slots[2].v as { ref: number }).ref; h.objs[row].slots[2].v = txt("'ben'"); },
        },
        { code: "rota[1]                  # Tuesday", result: "['ana', '-', 'ben']", note: "Tuesday was never assigned, and it shows both people. The row's refcount is 3.", run: () => {} },
      ],
      fixed: [
        {
          code: 'rota = [["-"] * 3 for _ in range(3)]',
          note: "The comprehension runs its expression three times, so there are three row lists.",
          run: (h) => { const rows = [0, 1, 2].map(() => alloc(h, "list", ["0", "1", "2"].map((k) => ({ key: k, v: txt("'-'") })))); bind(h, "rota", alloc(h, "list", rows.map((r, i) => ({ key: String(i), v: ref(r) })))); },
        },
        {
          code: 'rota[0][0] = "ana"       # Monday, early shift',
          note: "Only Monday's row changes.",
          run: (h) => { const row = (h.objs[nameTo(h, "rota")].slots[0].v as { ref: number }).ref; h.objs[row].slots[0].v = txt("'ana'"); },
        },
        {
          code: 'rota[2][2] = "ben"       # Wednesday, night shift',
          note: "Only Wednesday's row changes.",
          run: (h) => { const row = (h.objs[nameTo(h, "rota")].slots[2].v as { ref: number }).ref; h.objs[row].slots[2].v = txt("'ben'"); },
        },
        { code: "rota[1]                  # Tuesday", result: "['-', '-', '-']", note: "Tuesday is still empty. Each row has a refcount of 1.", run: () => {} },
      ],
    },
  },
  cycle: {
    title: "A reference cycle",
    ask: 5,
    lines: {
      bug: [
        {
          code: "run = InvoiceRun(invoices)",
          note: `A nightly run object, holding ${PDF_MB} MB of rendered PDFs. One name refers to it: refcount 1.`,
          run: (h) => { const p = alloc(h, "dict pdfs", [{ key: "312 entries", v: txt(`${PDF_MB} MB`) }], PDF_MB); bind(h, "run", alloc(h, "InvoiceRun", [{ key: "pdfs", v: ref(p) }])); },
        },
        { code: "report = run", note: "A second name for the same object. Refcount 2, still one object.", run: (h) => bind(h, "report", nameTo(h, "run")) },
        { code: "del report", note: "del removes a name, not an object. Refcount back to 1.", run: (h) => unbind(h, "report") },
        {
          code: "run.on_error = run.log_failure",
          note: "run.log_failure creates a bound method, which holds a reference to run in __self__. Storing it on run closes a loop: run → method → run.",
          run: (h) => { const r = nameTo(h, "run"); const m = alloc(h, "bound method", [{ key: "__func__", v: txt("log_failure") }, { key: "__self__", v: ref(r) }]); h.objs[r].slots.push({ key: "on_error", v: ref(m) }); },
        },
        {
          code: "del run                  # the run is finished",
          note: "No name reaches the run now, but its refcount is 1: the bound method still refers to it. Reference counting alone never frees these objects.",
          run: (h) => unbind(h, "run"),
        },
        { code: "gc.collect()", note: "The cycle collector finds objects that only refer to each other and frees them, PDFs included.", run: (h) => collect(h) },
      ],
      fixed: [
        {
          code: "run = InvoiceRun(invoices)",
          note: `A nightly run object, holding ${PDF_MB} MB of rendered PDFs. One name refers to it: refcount 1.`,
          run: (h) => { const p = alloc(h, "dict pdfs", [{ key: "312 entries", v: txt(`${PDF_MB} MB`) }], PDF_MB); bind(h, "run", alloc(h, "InvoiceRun", [{ key: "pdfs", v: ref(p) }])); },
        },
        { code: "report = run", note: "A second name for the same object. Refcount 2, still one object.", run: (h) => bind(h, "report", nameTo(h, "run")) },
        { code: "del report", note: "del removes a name, not an object. Refcount back to 1.", run: (h) => unbind(h, "report") },
        {
          code: "run.on_error = weakref.WeakMethod(run.log_failure)",
          note: "WeakMethod refers to run without counting. The temporary bound method is freed at the end of the line, by refcount.",
          run: (h) => {
            const r = nameTo(h, "run");
            const tmp = alloc(h, "bound method", [{ key: "__func__", v: txt("log_failure") }, { key: "__self__", v: ref(r) }]);
            bind(h, "(temporary)", tmp);
            const w = alloc(h, "WeakMethod", [{ key: "__func__", v: txt("log_failure") }, { key: "self (weak)", v: ref(r, true) }]);
            h.objs[r].slots.push({ key: "on_error", v: ref(w) });
            unbind(h, "(temporary)");
          },
        },
        { code: "del run                  # the run is finished", note: "The last strong reference is gone. Refcount 0: the run, its PDFs and the WeakMethod are freed on this line.", run: (h) => unbind(h, "run") },
        { code: "gc.collect()", note: "Nothing left for the collector to do.", run: (h) => collect(h) },
      ],
    },
  },
};

/** Replay the first `pc` lines of a program into a fresh heap. */
export function heapAt(prog: ProgId, fixed: boolean, pc: number): Heap {
  const h: Heap = { names: [], objs: {}, next: 1, freed: [] };
  for (const line of PROGRAMS[prog].lines[fixed ? "fixed" : "bug"].slice(0, pc)) {
    line.run(h);
    reclaim(h);
  }
  return h;
}

export interface Stats { objects: number; unreachable: number; stuckMb: number; byRefcount: number; byGc: number }
export function stats(h: Heap): Stats {
  const live = reachable(h);
  const lost = Object.values(h.objs).filter((o) => !live.has(o.id));
  return {
    objects: Object.keys(h.objs).length,
    unreachable: lost.length,
    stuckMb: lost.reduce((s, o) => s + (o.mb ?? 0), 0),
    byRefcount: h.freed.filter((f) => f.by === "refcount").length,
    byGc: h.freed.filter((f) => f.by === "gc").length,
  };
}

/* ---------------- the nightly loop ---------------- */

export const NIGHTS = 50;
/** The model's stand-in for CPython's allocation-count trigger: a collection every this many runs. */
export const COLLECT_EVERY = 10;

/**
 * Memory held by finished runs after each of `n` nightly runs. A run made with a cycle is
 * freed only by a collection; one made with WeakMethod is freed when its last name goes.
 */
export function nightly(design: "cycle" | "weak", gcOn: boolean, n = NIGHTS): number[] {
  const held: number[] = [];
  let dead = 0;
  for (let i = 1; i <= n; i++) {
    if (design === "cycle") dead++;
    if (gcOn && i % COLLECT_EVERY === 0) dead = 0;
    held.push(dead * PDF_MB);
  }
  return held;
}

/* ---------------- state ---------------- */

export type Guess = string;
export interface LoopRun { design: "cycle" | "weak"; gcOn: boolean; peak: number; end: number }

export interface State {
  prog: ProgId;
  fixed: boolean;
  pc: number;
  guesses: Partial<Record<ProgId, Guess>>;
  /** Program variants the reader has run to the end, as "prog:bug" / "prog:fixed". */
  finished: string[];
  loopGc: boolean;
  loops: LoopRun[];
}

export type Action =
  | { type: "prog"; prog: ProgId }
  | { type: "fixed"; fixed: boolean }
  | { type: "next" }
  | { type: "back" }
  | { type: "runTo"; pc: number }
  | { type: "guess"; value: Guess }
  | { type: "loopGc"; on: boolean }
  | { type: "loop"; design: "cycle" | "weak" }
  | { type: "reset" };

export function init(): State {
  return { prog: "defaults", fixed: false, pc: 0, guesses: {}, finished: [], loopGc: true, loops: [] };
}

export const linesOf = (st: State) => PROGRAMS[st.prog].lines[st.fixed ? "fixed" : "bug"];
const key = (st: State) => `${st.prog}:${st.fixed ? "fixed" : "bug"}`;

function at(st: State, pc: number): State {
  const n = linesOf(st).length;
  const p = Math.max(0, Math.min(n, pc));
  const finished = p === n && !st.finished.includes(key(st)) ? [...st.finished, key(st)] : st.finished;
  return { ...st, pc: p, finished };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "prog":
      return { ...st, prog: a.prog, fixed: false, pc: 0 };
    case "fixed":
      return { ...st, fixed: a.fixed, pc: 0 };
    case "next":
      return at(st, st.pc + 1);
    case "back":
      return at(st, st.pc - 1);
    case "runTo":
      return at(st, a.pc);
    case "guess":
      return st.guesses[st.prog] ? st : { ...st, guesses: { ...st.guesses, [st.prog]: a.value } };
    case "loopGc":
      return { ...st, loopGc: a.on };
    case "loop": {
      const held = nightly(a.design, st.loopGc);
      const run: LoopRun = { design: a.design, gcOn: st.loopGc, peak: Math.max(...held), end: held[held.length - 1] };
      return { ...st, loops: [...st.loops.filter((l) => l.design !== a.design || l.gcOn !== st.loopGc), run] };
    }
  }
}
