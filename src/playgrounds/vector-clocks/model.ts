// Vector clock playground: three cart replicas (A, B, C) exchanging messages on a space-time diagram.
//
// After this, the reader can answer: given two events, did one happen before the other or were
// they concurrent, why can a Lamport timestamp not tell the difference while a vector clock can,
// and how does a store use version vectors to keep both versions of a cart instead of dropping one?
//
// Two clocks run side by side:
// - Event clocks (Lamport 1978 and vector clocks): every event ticks its node's entry, a receive
//   first takes the element-wise max (vector) or max (Lamport) with the message's timestamp.
// - Version vectors on the cart data: only writes and merges tick, so replicas that exchange the
//   same data agree on its version. A replica that receives a version compares vectors: newer
//   replaces, older is ignored, concurrent is kept as a sibling.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const NODES = ["A", "B", "C"] as const;
export type NodeId = 0 | 1 | 2;
export type Vec = [number, number, number];
export type Kind = "write" | "send" | "recv" | "merge";
export type Relation = "before" | "after" | "equal" | "concurrent";
export type Outcome = "replaced" | "kept" | "conflict" | "same";

export interface Version { items: string[]; vv: Vec }

export interface Ev {
  id: number;
  node: NodeId;
  kind: Kind;
  vc: Vec;
  lamport: number;
  /** Per-node sequence, for names like A3. */
  seq: number;
  label: string;
  msg?: number;
  outcome?: Outcome;
  /** Items last-write-wins by Lamport time would have dropped at this receive. */
  drops?: string[];
}

export interface Msg { id: number; from: NodeId; to: NodeId; send: number; vc: Vec; lamport: number; payload: Version[]; recv?: number }

export interface Replica { vc: Vec; lamport: number; versions: Version[]; seq: number }

export type Challenge = "lamport-lies" | "causal" | "conflict" | "resolved";

export interface State {
  nodes: [Replica, Replica, Replica];
  events: Ev[];
  msgs: Msg[];
  item: number;
  selected: number[];
  /** What a receive did, for the explanation line. */
  last: { event: number; outcome: Outcome; lwwDrops: string[] } | null;
  done: Challenge[];
}

export type Action =
  | { type: "write"; node: NodeId }
  | { type: "send"; from: NodeId; to: NodeId }
  | { type: "deliver"; msg: number }
  | { type: "merge"; node: NodeId }
  | { type: "select"; event: number }
  | { type: "reset" };

export const ITEMS = ["book", "lamp", "mug", "pen", "desk", "chair", "kettle", "rug", "plant", "clock"];

const zero = (): Vec => [0, 0, 0];
const replica = (): Replica => ({ vc: zero(), lamport: 0, versions: [{ items: [], vv: zero() }], seq: 0 });

export function init(): State {
  return { nodes: [replica(), replica(), replica()], events: [], msgs: [], item: 0, selected: [], last: null, done: [] };
}

/** Compare two vectors: a before b means a ≤ b everywhere and a < b somewhere. */
export function compare(a: Vec, b: Vec): Relation {
  let less = false, more = false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) less = true;
    if (a[i] > b[i]) more = true;
  }
  if (less && more) return "concurrent";
  if (less) return "before";
  if (more) return "after";
  return "equal";
}

const max = (a: Vec, b: Vec): Vec => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
const tick = (v: Vec, i: NodeId): Vec => { const n = [...v] as Vec; n[i]++; return n; };
export const fmt = (v: Vec) => `[${v.join(",")}]`;
export const evName = (st: State, id: number) => { const e = st.events[id]; return `${NODES[e.node]}${e.seq}`; };

/** Keep every version that no other version dominates (siblings), dropping duplicates. */
export function reconcile(vs: Version[]): Version[] {
  const out: Version[] = [];
  for (const v of vs) {
    if (vs.some((w) => compare(v.vv, w.vv) === "before")) continue;
    if (out.some((w) => compare(v.vv, w.vv) === "equal")) continue;
    out.push(v);
  }
  return out;
}

function addEvent(st: State, node: NodeId, kind: Kind, label: string, upd: Partial<Replica>, extra: Partial<Ev> = {}, incoming?: { vc: Vec; lamport: number }): State {
  const r = st.nodes[node];
  const vc = tick(incoming ? max(r.vc, incoming.vc) : r.vc, node);
  const lamport = Math.max(r.lamport, incoming?.lamport ?? 0) + 1;
  const seq = r.seq + 1;
  const ev: Ev = { id: st.events.length, node, kind, vc, lamport, seq, label, ...extra };
  const nodes = [...st.nodes] as State["nodes"];
  nodes[node] = { ...r, ...upd, vc, lamport, seq };
  return { ...st, nodes, events: [...st.events, ev] };
}

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  if (st.selected.length === 2) {
    const [a, b] = st.selected.map((i) => st.events[i]);
    const rel = compare(a.vc, b.vc);
    if (rel === "concurrent" && a.lamport !== b.lamport) got.add("lamport-lies");
    if ((rel === "before" || rel === "after") && a.node !== b.node) got.add("causal");
  }
  if (st.events.some((e) => e.outcome === "conflict")) got.add("conflict");
  // A merged version reached another replica and simply replaced what was there.
  if (st.events.some((e) => e.kind === "recv" && e.outcome === "replaced" && st.msgs[e.msg!].payload.length === 1 &&
    st.events.some((m) => m.kind === "merge" && m.node === st.msgs[e.msg!].from && m.id < st.msgs[e.msg!].send))) got.add("resolved");
  return (["lamport-lies", "causal", "conflict", "resolved"] as Challenge[]).filter((c) => got.has(c));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "select": {
      const has = st.selected.includes(a.event);
      const selected = has ? st.selected.filter((x) => x !== a.event) : [...st.selected, a.event].slice(-2);
      const next = { ...st, selected };
      return { ...next, done: challenges(next) };
    }
    case "write": {
      const r = st.nodes[a.node];
      if (r.versions.length > 1) return st; // resolve the siblings first
      const item = ITEMS[st.item % ITEMS.length];
      const cur = r.versions[0];
      const versions = [{ items: [...cur.items, item], vv: tick(cur.vv, a.node) }];
      return { ...addEvent(st, a.node, "write", `+${item}`, { versions }), item: st.item + 1, last: null };
    }
    case "merge": {
      const r = st.nodes[a.node];
      if (r.versions.length < 2) return st;
      const items = [...new Set(r.versions.flatMap((v) => v.items))];
      const vv = tick(r.versions.reduce((m, v) => max(m, v.vv), zero()), a.node);
      const next = addEvent(st, a.node, "merge", "merge", { versions: [{ items, vv }] });
      return { ...next, last: null, done: challenges(next) };
    }
    case "send": {
      if (a.from === a.to) return st;
      const r = st.nodes[a.from];
      const id = st.msgs.length;
      const next = addEvent(st, a.from, "send", `→${NODES[a.to]}`, {}, { msg: id });
      const ev = next.events[next.events.length - 1];
      const msg: Msg = { id, from: a.from, to: a.to, send: ev.id, vc: ev.vc, lamport: ev.lamport, payload: r.versions.map((v) => ({ items: [...v.items], vv: [...v.vv] as Vec })) };
      return { ...next, msgs: [...next.msgs, msg], last: null };
    }
    case "deliver": {
      const m = st.msgs[a.msg];
      if (!m || m.recv !== undefined) return st;
      const r = st.nodes[m.to];
      const mine = r.versions;
      const merged = reconcile([...mine, ...m.payload]);
      let outcome: Outcome;
      const same = (x: Version[], y: Version[]) => x.length === y.length && x.every((v) => y.some((w) => compare(v.vv, w.vv) === "equal"));
      if (same(merged, mine)) outcome = same(m.payload, mine) ? "same" : "kept";
      else if (same(merged, m.payload)) outcome = "replaced";
      else outcome = "conflict";
      // Counterfactual: last-write-wins by Lamport timestamp keeps one side and drops the other's items.
      let lwwDrops: string[] = [];
      if (outcome === "conflict") {
        const myL = r.lamport, theirL = m.lamport;
        const keep = theirL > myL || (theirL === myL && m.from < m.to) ? m.payload : mine;
        const kept = new Set(keep.flatMap((v) => v.items));
        lwwDrops = [...new Set(merged.flatMap((v) => v.items))].filter((x) => !kept.has(x));
      }
      const next = addEvent(st, m.to, "recv", `←${NODES[m.from]}`, { versions: merged }, { msg: m.id, outcome, drops: lwwDrops }, { vc: m.vc, lamport: m.lamport });
      const ev = next.events[next.events.length - 1];
      const msgs = next.msgs.map((x) => (x.id === m.id ? { ...x, recv: ev.id } : x));
      const out = { ...next, msgs, last: { event: ev.id, outcome, lwwDrops } };
      return { ...out, done: challenges(out) };
    }
  }
}

/** For a selected event: which events are in its causal past, its future, or concurrent with it. */
export function cone(st: State, id: number): Relation[] {
  const e = st.events[id];
  return st.events.map((x) => compare(x.vc, e.vc));
}

export const pending = (st: State, node: NodeId) => st.msgs.filter((m) => m.to === node && m.recv === undefined);
