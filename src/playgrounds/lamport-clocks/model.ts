// Lamport clock playground: three chat servers (A, B, C) on a space-time diagram.
//
// After this, the reader can answer: why does sorting by wall-clock time show an effect before its
// cause when clocks are skewed, how does a Lamport clock (max of local and received, plus one)
// guarantee that a cause always sorts first, and why does a smaller Lamport time still not mean
// that one event caused the other?
//
// The model keeps three views of every event:
// - real time (when it actually happened; the x axis of the diagram),
// - the server's wall clock (real time plus that server's skew, which the reader can change),
// - the Lamport time (Lamport 1978, rules IR1 and IR2) and a total order (L, server id).
// It also tracks vector clocks internally, only to know the truth about happened-before, so the
// view can mark when an order puts an effect before its cause.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const NODES = ["A", "B", "C"] as const;
export type NodeId = 0 | 1 | 2;
export type Vec = [number, number, number];
export type Kind = "post" | "send" | "recv";

export interface Ev {
  id: number;
  node: NodeId;
  kind: Kind;
  /** Real time in ms. */
  t: number;
  /** Lamport time. */
  L: number;
  /** Hidden truth: vector clock, used only to decide happened-before. */
  vc: Vec;
  /** Per-node sequence, for names like B2. */
  seq: number;
  msg?: number;
  /** For a receive: the Lamport time the node had just before it. */
  prevL?: number;
}

export interface Msg { id: number; from: NodeId; to: NodeId; send: number; L: number; vc: Vec; recv?: number }

export type Challenge = "wall-lies" | "jump" | "tie" | "not-cause";

export const SKEWS = [0, -40, -80, -150] as const;
export type Skew = (typeof SKEWS)[number];

export interface State {
  now: number;
  clocks: [number, number, number];
  vcs: [Vec, Vec, Vec];
  seqs: [number, number, number];
  events: Ev[];
  msgs: Msg[];
  /** Skew of each server's wall clock, ms. A is the reference; C runs a little fast. */
  skew: [number, number, number];
  selected: number[];
  done: Challenge[];
}

export type Action =
  | { type: "post"; node: NodeId }
  | { type: "send"; from: NodeId; to: NodeId }
  | { type: "deliver"; msg: number }
  | { type: "skewB"; ms: Skew }
  | { type: "select"; event: number }
  | { type: "reset" };

/** Real time advances this much per action, so every event has its own instant. */
export const STEP_MS = 20;
export const START_MS = 1000;
const C_SKEW = 25;

export function init(): State {
  return {
    now: START_MS, clocks: [0, 0, 0], vcs: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], seqs: [0, 0, 0],
    events: [], msgs: [], skew: [0, -80, C_SKEW], selected: [], done: [],
  };
}

const max = (a: Vec, b: Vec): Vec => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];

/** True if a happened before b (Lamport's relation): a's vector ≤ b's and not equal. */
export function hb(a: Ev, b: Ev): boolean {
  let less = false;
  for (let i = 0; i < 3; i++) {
    if (a.vc[i] > b.vc[i]) return false;
    if (a.vc[i] < b.vc[i]) less = true;
  }
  return less;
}

export const wall = (st: State, e: Ev) => e.t + st.skew[e.node];
export const evName = (e: Ev) => `${NODES[e.node]}${e.seq}`;

/** The total order Lamport defined: by L, ties broken by a fixed order of the servers. */
export const lamportOrder = (st: State) => [...st.events].sort((a, b) => a.L - b.L || a.node - b.node);
/** What a log sorted by server timestamps shows (ties by server id). */
export const wallOrder = (st: State) => [...st.events].sort((a, b) => wall(st, a) - wall(st, b) || a.node - b.node);

/** Pairs (cause, effect) that an order shows the wrong way round. */
export function inversions(order: Ev[]): [Ev, Ev][] {
  const out: [Ev, Ev][] = [];
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++)
      if (hb(order[j], order[i])) out.push([order[j], order[i]]);
  return out;
}

/** Pairs of events on different servers that share a Lamport time; the server id decides. */
export function ties(st: State): [Ev, Ev][] {
  const out: [Ev, Ev][] = [];
  for (let i = 0; i < st.events.length; i++)
    for (let j = i + 1; j < st.events.length; j++)
      if (st.events[i].L === st.events[j].L && st.events[i].node !== st.events[j].node) out.push([st.events[i], st.events[j]]);
  return out;
}

/** Pairs where a has the smaller Lamport time but did not happen before b. */
export function misleading(st: State): [Ev, Ev][] {
  const out: [Ev, Ev][] = [];
  for (const a of st.events) for (const b of st.events) if (a.L < b.L && !hb(a, b)) out.push([a, b]);
  return out;
}

function addEvent(st: State, node: NodeId, kind: Kind, extra: Partial<Ev>, incoming?: { L: number; vc: Vec }): State {
  const prev = st.clocks[node];
  // IR1: tick on every event. IR2: on receive, first move past the message's timestamp.
  const L = Math.max(prev, incoming?.L ?? 0) + 1;
  const vc = [...(incoming ? max(st.vcs[node], incoming.vc) : st.vcs[node])] as Vec;
  vc[node]++;
  const seq = st.seqs[node] + 1;
  const now = st.now + STEP_MS;
  const ev: Ev = { id: st.events.length, node, kind, t: now, L, vc, seq, ...extra, ...(incoming ? { prevL: prev } : {}) };
  const clocks = [...st.clocks] as State["clocks"]; clocks[node] = L;
  const vcs = [...st.vcs] as State["vcs"]; vcs[node] = vc;
  const seqs = [...st.seqs] as State["seqs"]; seqs[node] = seq;
  return { ...st, now, clocks, vcs, seqs, events: [...st.events, ev] };
}

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  if (inversions(wallOrder(st)).length > 0) got.add("wall-lies");
  if (st.events.some((e) => e.kind === "recv" && e.L > (e.prevL ?? 0) + 1)) got.add("jump");
  if (ties(st).length > 0) got.add("tie");
  if (st.selected.length === 2) {
    const [a, b] = st.selected.map((i) => st.events[i]);
    if (a.L !== b.L && !hb(a, b) && !hb(b, a)) got.add("not-cause");
  }
  return (["wall-lies", "jump", "tie", "not-cause"] as Challenge[]).filter((c) => got.has(c));
}

const finish = (st: State): State => ({ ...st, done: challenges(st) });

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "post":
      return finish(addEvent(st, a.node, "post", {}));
    case "send": {
      if (a.from === a.to) return st;
      const id = st.msgs.length;
      const next = addEvent(st, a.from, "send", { msg: id });
      const ev = next.events[next.events.length - 1];
      const msg: Msg = { id, from: a.from, to: a.to, send: ev.id, L: ev.L, vc: ev.vc };
      return finish({ ...next, msgs: [...next.msgs, msg] });
    }
    case "deliver": {
      const m = st.msgs[a.msg];
      if (!m || m.recv !== undefined) return st;
      const next = addEvent(st, m.to, "recv", { msg: m.id }, { L: m.L, vc: m.vc });
      const ev = next.events[next.events.length - 1];
      return finish({ ...next, msgs: next.msgs.map((x) => (x.id === m.id ? { ...x, recv: ev.id } : x)) });
    }
    case "skewB": {
      const skew = [...st.skew] as State["skew"]; skew[1] = a.ms;
      return finish({ ...st, skew });
    }
    case "select": {
      if (!st.events[a.event]) return st;
      const has = st.selected.includes(a.event);
      const selected = has ? st.selected.filter((x) => x !== a.event) : [...st.selected, a.event].slice(-2);
      return finish({ ...st, selected });
    }
  }
}

export const pending = (st: State, node: NodeId) => st.msgs.filter((m) => m.to === node && m.recv === undefined);
