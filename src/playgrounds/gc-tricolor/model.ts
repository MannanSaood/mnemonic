// Garbage collection: a small heap graph that the reader marks by hand with the tri-colour
// algorithm, while the program (the mutator) keeps moving pointers.
//
// Purpose. After this, the reader can answer: "Why does a concurrent garbage collector need a
// write barrier?" If the program moves the only pointer to a white object into an object the
// collector has already scanned (black), and deletes the pointer from the grey object that would
// have led there, the collector never sees the white object and frees it while it is still in
// use. The write barrier shades the object on that pointer store, so it survives.
//
// Rules (Dijkstra/Yuasa tri-colour marking, as Go uses it):
// - Start: a short stop-the-world turns the barrier on; objects the roots point to turn grey.
// - Scanning a grey object: each white object it points to turns grey, then it turns black.
// - Marking ends when nothing is grey. Sweep frees every object still white.
// - Objects allocated during marking are black at once.
// - Barrier on: a pointer store during marking shades the old target and the new target
//   (Go's hybrid barrier shades the new one only while the storing goroutine's stack is grey;
//   our login handler's stack is treated as grey throughout).
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Color = "white" | "grey" | "black";
export type Phase = "idle" | "mark" | "marked" | "swept";
export type Mutation = "merge" | "add" | "drop";

export interface ObjDef { id: string; label: string; sub: string; x: number; y: number }
export interface Obj extends ObjDef { color: Color; freed: boolean; isNew: boolean }
export interface Root { id: string; label: string; sub: string; x: number; y: number }
export type Edge = [from: string, to: string];

/** Layout in a 600 x 380 box. */
export const W = 600;
export const H = 380;
export const ROOTS: Root[] = [
  { id: "stack", label: "stack", sub: "login handler", x: 70, y: 30 },
  { id: "globals", label: "globals", sub: "var sessions", x: 370, y: 30 },
];
export const OBJS: ObjDef[] = [
  { id: "req", label: "Request", sub: "POST /login", x: 70, y: 110 },
  { id: "body", label: "[]byte", sub: "request body", x: 70, y: 190 },
  { id: "sessions", label: "sessions", sub: "map", x: 370, y: 110 },
  { id: "x9", label: "Session x9", sub: "expired", x: 215, y: 190 },
  { id: "xcart", label: "Cart x9", sub: "", x: 215, y: 270 },
  { id: "u42", label: "Session u42", sub: "logged in", x: 370, y: 190 },
  { id: "user", label: "User u42", sub: "", x: 370, y: 270 },
  { id: "g7", label: "Session g7", sub: "guest", x: 525, y: 190 },
  { id: "cart", label: "Cart g7", sub: "3 items", x: 525, y: 270 },
  { id: "item", label: "LineItem", sub: "", x: 525, y: 350 },
];
export const NEW_ITEM: ObjDef = { id: "item2", label: "LineItem", sub: "new", x: 370, y: 350 };

export const START_EDGES: Edge[] = [
  ["stack", "req"], ["globals", "sessions"],
  ["req", "body"], ["sessions", "u42"], ["sessions", "g7"],
  ["u42", "user"], ["g7", "cart"], ["cart", "item"], ["x9", "xcart"],
];

export const MUTATION: Record<Mutation, { label: string; code: string }> = {
  merge: { label: "Log in: move the guest cart", code: "u42.Cart = g7.Cart; g7.Cart = nil" },
  add: { label: "Add an item to the cart", code: "cart.Items = append(cart.Items, &LineItem{…})" },
  drop: { label: "Expire the guest session", code: `delete(sessions, "g7")` },
};

export interface RunResult {
  barrier: boolean; merged: boolean; freedLive: string[]; freedGarbage: number; floating: number; scanned: number; followed: number; shades: number;
}

export type Guess = "survives" | "freed" | "rescan";

export interface State {
  barrier: boolean;
  phase: Phase;
  objs: Record<string, Obj>;
  edges: Edge[];
  greyOrder: string[];
  done: Record<Mutation, boolean>;
  scanned: number; followed: number; shades: number;
  /** Objects the barrier shaded in the last mutation, and edges the last mutation added. */
  flash: string[]; fresh: Edge[];
  events: string[];
  guess: Guess | null;
  runs: RunResult[];
  last: RunResult | null;
}

export type Action =
  | { type: "barrier"; on: boolean }
  | { type: "start" }
  | { type: "scan"; id: string }
  | { type: "scanNext" }
  | { type: "finish" }
  | { type: "sweep" }
  | { type: "mutate"; m: Mutation }
  | { type: "guess"; guess: Guess }
  | { type: "again" }
  | { type: "reset" };

const freshHeap = () => ({
  phase: "idle" as Phase,
  objs: Object.fromEntries(OBJS.map((o) => [o.id, { ...o, color: "white" as Color, freed: false, isNew: false }])) as Record<string, Obj>,
  edges: START_EDGES.map((e) => [...e] as Edge),
  greyOrder: [] as string[],
  done: { merge: false, add: false, drop: false },
  scanned: 0, followed: 0, shades: 0, flash: [] as string[], fresh: [] as Edge[], events: [] as string[], last: null,
});

export function init(): State {
  return { barrier: true, ...freshHeap(), guess: null, runs: [] };
}

export const isRoot = (id: string) => ROOTS.some((r) => r.id === id);
export const greys = (s: State) => s.greyOrder.filter((id) => s.objs[id]?.color === "grey");
export const label = (s: State, id: string) => ROOTS.find((r) => r.id === id)?.label ?? s.objs[id]?.label ?? id;

/** Objects reachable from the roots over the current pointers. */
export function reachable(s: { edges: Edge[] }): Set<string> {
  const seen = new Set<string>();
  const todo = ROOTS.map((r) => r.id);
  while (todo.length) {
    const id = todo.pop()!;
    for (const [f, t] of s.edges) if (f === id && !seen.has(t)) { seen.add(t); todo.push(t); }
  }
  return seen;
}

type Draft = Pick<State, "objs" | "greyOrder" | "events"> & { shades: number; flash: string[] };

function shade(d: Draft, id: string | undefined, why: string) {
  if (!id) return;
  const o = d.objs[id];
  if (!o || o.color !== "white") return;
  o.color = "grey"; d.greyOrder.push(id); d.shades++; d.flash.push(id);
  d.events.unshift(`Write barrier: ${why} shades ${o.label} grey.`);
}

function cloneObjs(s: State) {
  return Object.fromEntries(Object.entries(s.objs).map(([k, o]) => [k, { ...o }])) as Record<string, Obj>;
}

function scan(s: State, id: string): State {
  const o = s.objs[id];
  if (s.phase !== "mark" || !o || o.color !== "grey") return s;
  const objs = cloneObjs(s);
  const greyOrder = [...s.greyOrder];
  const found: string[] = [];
  let followed = s.followed;
  for (const [f, t] of s.edges) {
    if (f !== id) continue;
    followed++;
    if (objs[t].color === "white") { objs[t].color = "grey"; greyOrder.push(t); found.push(objs[t].label); }
  }
  objs[id].color = "black";
  const ev = `Scanned ${o.label}: ${found.length ? `shaded ${found.join(", ")} grey` : "no white objects behind it"}. It is black now.`;
  const left = greyOrder.filter((g) => objs[g].color === "grey");
  const next: State = { ...s, objs, greyOrder, followed, scanned: s.scanned + 1, flash: [], fresh: [], events: [ev, ...s.events].slice(0, 30) };
  if (left.length) return next;
  return { ...next, phase: "marked", events: ["Nothing is grey: marking is done. Mark termination stops the world briefly, then sweep frees whatever is still white.", ...next.events] };
}

function mutate(s: State, m: Mutation): State {
  if (s.done[m] || s.phase === "marked" || s.phase === "swept") return s;
  if (m === "add" && s.objs.item2) return s;
  const marking = s.phase === "mark";
  const d: Draft = { objs: cloneObjs(s), greyOrder: [...s.greyOrder], events: [], shades: s.shades, flash: [] };
  let edges = s.edges.map((e) => [...e] as Edge);
  let fresh: Edge[] = [];
  const target = (from: string, to: string) => edges.find(([f, t]) => f === from && t === to);
  if (m === "merge") {
    const cartFrom = edges.find(([f, t]) => t === "cart" && f === "g7");
    if (!cartFrom) return s;
    // u42.Cart = g7.Cart
    if (marking && s.barrier) shade(d, "cart", "storing the cart pointer into Session u42");
    edges.push(["u42", "cart"]); fresh = [["u42", "cart"]];
    // g7.Cart = nil
    if (marking && s.barrier) shade(d, "cart", "overwriting Session g7's cart pointer");
    edges = edges.filter((e) => !(e[0] === "g7" && e[1] === "cart"));
    d.events.push(`Mutator: ${MUTATION.merge.code}. The cart now hangs off Session u42 only.`);
  } else if (m === "add") {
    const cartOwner = edges.find(([, t]) => t === "cart");
    if (!cartOwner) return s;
    d.objs.item2 = { ...NEW_ITEM, color: marking ? "black" : "white", freed: false, isNew: true };
    edges.push(["cart", "item2"]); fresh = [["cart", "item2"]];
    d.events.push(marking
      ? "Mutator: a new LineItem is allocated during marking, so it starts black. The GC will not free it this cycle."
      : "Mutator: a new LineItem is allocated. No cycle is running, so it is simply white.");
  } else {
    if (!target("sessions", "g7")) return s;
    if (marking && s.barrier) shade(d, "g7", "deleting the map entry");
    edges = edges.filter((e) => !(e[0] === "sessions" && e[1] === "g7"));
    d.events.push(`Mutator: ${MUTATION.drop.code}. Session g7 is garbage from now on.`);
  }
  return {
    ...s, objs: d.objs, greyOrder: d.greyOrder, shades: d.shades, flash: d.flash, fresh, edges,
    done: { ...s.done, [m]: true },
    events: [...d.events.reverse(), ...s.events].slice(0, 30),
    phase: s.phase,
  };
}

function sweep(s: State): State {
  if (s.phase !== "marked") return s;
  const objs = cloneObjs(s);
  const live = reachable(s);
  const freedLive: string[] = [];
  let freedGarbage = 0, floating = 0;
  for (const o of Object.values(objs)) {
    if (o.color === "white") { o.freed = true; if (live.has(o.id)) freedLive.push(o.label); else freedGarbage++; }
    else if (!live.has(o.id)) floating++;
  }
  const res: RunResult = { barrier: s.barrier, merged: s.done.merge, freedLive, freedGarbage, floating, scanned: s.scanned, followed: s.followed, shades: s.shades };
  const ev = freedLive.length
    ? `Sweep freed ${freedLive.join(" and ")} while live pointers still lead to them. The next access reads freed memory.`
    : `Sweep freed ${freedGarbage} garbage object${freedGarbage === 1 ? "" : "s"} and no live one.${floating ? ` ${floating} dead object${floating === 1 ? "" : "s"} survive this cycle as floating garbage.` : ""}`;
  return { ...s, objs, phase: "swept", flash: [], fresh: [], last: res, runs: [...s.runs, res], events: [ev, ...s.events].slice(0, 30) };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "again": return { ...s, ...freshHeap() };
    case "barrier": return s.phase === "idle" || s.phase === "swept" ? { ...s, ...freshHeap(), barrier: a.on } : s;
    case "guess": return s.runs.some((r) => !r.barrier && r.merged) ? s : { ...s, guess: a.guess };
    case "start": {
      if (s.phase !== "idle") return s;
      const objs = cloneObjs(s);
      const greyOrder: string[] = [];
      for (const [f, t] of s.edges) if (isRoot(f) && objs[t].color === "white") { objs[t].color = "grey"; greyOrder.push(t); }
      const ev = `Cycle starts. A short stop-the-world turns the write barrier ${s.barrier ? "on" : "off (what if)"}; the objects the roots point to turn grey.`;
      return { ...s, objs, greyOrder, phase: "mark", flash: [], fresh: [], events: [ev, ...s.events].slice(0, 30) };
    }
    case "scan": return scan(s, a.id);
    case "scanNext": { const g = greys(s); return g.length ? scan(s, g[0]) : s; }
    case "finish": {
      let cur = s;
      for (let i = 0; i < 50 && cur.phase === "mark"; i++) cur = step(cur, { type: "scanNext" });
      return cur;
    }
    case "sweep": return sweep(s);
    case "mutate": return mutate(s, a.m);
  }
}

/** Plays a script of actions from a fresh heap. Used by tests. */
export function play(barrier: boolean, ...actions: Action[]): State {
  return actions.reduce(step, step(init(), { type: "barrier", on: barrier }));
}
