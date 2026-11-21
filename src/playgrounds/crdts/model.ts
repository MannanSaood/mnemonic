// CRDT playground: three replicas of a household shopping list, edited offline and synced by hand.
//
// After this, the reader can answer: why do CRDT replicas end up identical whatever order they
// sync in and however often (the merge is commutative, associative and idempotent), and what does
// each design keep or drop when edits are concurrent: a PN-Counter keeps every tap, an OR-Set lets
// a concurrent add win over a remove, and an LWW-Register silently drops one of two choices?
//
// Each replica holds one document made of three state-based CRDTs (Shapiro et al., 2011):
// - eggs: a PN-Counter, two G-Counters (one entry per replica for increments, one for decrements),
// - items: an OR-Set, every add carries a unique tag, a remove tombstones only the tags it saw,
// - slot: an LWW-Register stamped with (Lamport time, replica id).
// Alongside, each replica runs a naive version fed the same edits and syncs: a plain integer
// merged by max, and a plain set merged by union. The view compares the two.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const NODES = ["A", "B", "C"] as const;
export const NODE_NAMES = ["Phone A", "Phone B", "Laptop C"] as const;
export type NodeId = 0 | 1 | 2;
export type Vec = [number, number, number];

export const ITEMS = ["oat milk", "bread", "eggs", "coffee", "apples", "rice", "pasta", "yogurt"] as const;
export const SLOTS = ["Sat 10:00", "Sat 18:00", "Sun 10:00"] as const;

export interface PN { p: Vec; n: Vec }
export interface Tagged { e: string; tag: string }
export interface ORSet { adds: Tagged[]; removed: string[] }
export interface Reg { value: string; ts: [number, number]; id: string; history: string[] }
export interface Doc { eggs: PN; items: ORSet; slot: Reg; clock: number }
export interface Naive { eggs: number; items: string[] }
export interface Replica { doc: Doc; naive: Naive; seq: number; edits: number }

export type Challenge = "concurrent-inc" | "resurrect" | "add-wins" | "lww-lost" | "negative";
export interface Lost { id: string; value: string; by: NodeId; winner: string }
export interface SyncRec { from: NodeId; to: NodeId; changed: boolean; text: string }

export interface State {
  nodes: [Replica, Replica, Replica];
  syncs: SyncRec[];
  lost: Lost[];
  done: Challenge[];
}

export type Action =
  | { type: "inc"; node: NodeId }
  | { type: "dec"; node: NodeId }
  | { type: "add"; node: NodeId; item: string }
  | { type: "remove"; node: NodeId; item: string }
  | { type: "slot"; node: NodeId; value: string }
  | { type: "sync"; from: NodeId; to: NodeId }
  | { type: "syncAll" }
  | { type: "reset" };

// ---------------- the CRDTs ----------------

const vmax = (a: Vec, b: Vec): Vec => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
const sum = (v: Vec) => v[0] + v[1] + v[2];
export const pnValue = (c: PN) => sum(c.p) - sum(c.n);
export const pnMerge = (a: PN, b: PN): PN => ({ p: vmax(a.p, b.p), n: vmax(a.n, b.n) });

const uniq = (xs: string[]) => [...new Set(xs)].sort();
/** States are kept in one canonical order, so equal states compare equal. */
const byTagOrder = (ts: Tagged[]) => [...ts].sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));
export function setMerge(a: ORSet, b: ORSet): ORSet {
  const byTag = new Map<string, Tagged>();
  for (const t of [...a.adds, ...b.adds]) byTag.set(t.tag, t);
  return { adds: byTagOrder([...byTag.values()]), removed: uniq([...a.removed, ...b.removed]) };
}
/** Elements with at least one tag that no remove has seen, in list order. */
export function setValue(s: ORSet): string[] {
  const dead = new Set(s.removed);
  const live = new Set(s.adds.filter((t) => !dead.has(t.tag)).map((t) => t.e));
  return ITEMS.filter((e) => live.has(e));
}

const newer = (a: Reg, b: Reg) => a.ts[0] > b.ts[0] || (a.ts[0] === b.ts[0] && a.ts[1] > b.ts[1]);
export function regMerge(a: Reg, b: Reg): Reg {
  if (a.id === b.id) return { ...a, history: uniq([...a.history, ...b.history]) };
  const [win, lose] = newer(a, b) ? [a, b] : [b, a];
  return { ...win, history: uniq([...a.history, ...b.history, lose.id]) };
}

export function merge(a: Doc, b: Doc): Doc {
  return { eggs: pnMerge(a.eggs, b.eggs), items: setMerge(a.items, b.items), slot: regMerge(a.slot, b.slot), clock: Math.max(a.clock, b.clock) };
}
export const same = (a: Doc, b: Doc) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- initial state ----------------

function doc(): Doc {
  return {
    eggs: { p: [1, 0, 0], n: [0, 0, 0] },
    items: { adds: [{ e: "oat milk", tag: "A0" }, { e: "bread", tag: "B0" }], removed: [] },
    slot: { value: SLOTS[0], ts: [0, 0], id: "init", history: [] },
    clock: 0,
  };
}
const replica = (): Replica => ({ doc: doc(), naive: { eggs: 1, items: ["oat milk", "bread"] }, seq: 0, edits: 0 });

export function init(): State {
  return { nodes: [replica(), replica(), replica()], syncs: [], lost: [], done: [] };
}

// ---------------- derived ----------------

export const eggs = (r: Replica) => pnValue(r.doc.eggs);
export const items = (r: Replica) => setValue(r.doc.items);
export const converged = (st: State) => same(st.nodes[0].doc, st.nodes[1].doc) && same(st.nodes[1].doc, st.nodes[2].doc);
/** Items the naive union shows that the OR-Set removed on this replica. */
export function resurrected(r: Replica): string[] {
  const live = new Set(items(r));
  const dead = new Set(r.doc.items.removed);
  const removedEls = new Set(r.doc.items.adds.filter((t) => dead.has(t.tag)).map((t) => t.e));
  return r.naive.items.filter((e) => !live.has(e) && removedEls.has(e));
}
export const tombstones = (r: Replica) => r.doc.items.removed.length;
export const tags = (r: Replica) => r.doc.items.adds.length;

export interface Laws { commutative: boolean; associative: boolean; idempotent: boolean }
export function laws(st: State): Laws {
  const [a, b, c] = st.nodes.map((r) => r.doc);
  return {
    commutative: same(merge(a, b), merge(b, a)) && same(merge(b, c), merge(c, b)) && same(merge(a, c), merge(c, a)),
    associative: same(merge(merge(a, b), c), merge(a, merge(b, c))),
    idempotent: same(merge(a, a), a) && same(merge(b, b), b) && same(merge(c, c), c),
  };
}

// ---------------- step ----------------

function setNode(st: State, i: NodeId, r: Replica): State {
  const nodes = [...st.nodes] as State["nodes"];
  nodes[i] = r;
  return { ...st, nodes };
}

const edit = (r: Replica, d: Partial<Doc>, n: Partial<Naive>): Replica =>
  ({ ...r, doc: { ...r.doc, ...d }, naive: { ...r.naive, ...n }, edits: r.edits + 1 });

function syncOne(st: State, from: NodeId, to: NodeId): State {
  if (from === to) return st;
  const src = st.nodes[from], dst = st.nodes[to];
  const merged = merge(dst.doc, src.doc);
  const changed = !same(merged, dst.doc);
  const got = new Set(st.done);
  const notes: string[] = [];

  // Concurrent increments: each side is ahead in some entry.
  for (const k of ["p", "n"] as const) {
    const a = dst.doc.eggs[k], b = src.doc.eggs[k];
    if (a.some((x, i) => x > b[i]) && b.some((x, i) => x > a[i])) {
      got.add("concurrent-inc");
      notes.push(`Both had ${k === "p" ? "+1" : "−1"} taps the other had not seen; per-replica max keeps all of them.`);
    }
  }
  // Add wins: an element the receiver had removed survives because of a tag its remove never saw.
  const dead = new Set(dst.doc.items.removed);
  const hadRemoved = new Set(dst.doc.items.adds.filter((t) => dead.has(t.tag)).map((t) => t.e));
  const before = new Set(setValue(dst.doc.items));
  for (const e of setValue(merged.items)) {
    if (!before.has(e) && hadRemoved.has(e)) {
      got.add("add-wins");
      notes.push(`${NODES[to]} had removed ${e}, but ${NODES[from]} added it with a tag that remove never saw. Add wins.`);
    }
  }
  // LWW: a concurrent assignment loses without trace.
  let lost = st.lost;
  const [ra, rb] = [dst.doc.slot, src.doc.slot];
  if (ra.id !== rb.id) {
    const win = newer(ra, rb) ? ra : rb, lose = win === ra ? rb : ra;
    if (!win.history.includes(lose.id) && lose.id !== "init" && !lost.some((l) => l.id === lose.id)) {
      lost = [...lost, { id: lose.id, value: lose.value, by: lose.ts[1] as NodeId, winner: win.value }];
      got.add("lww-lost");
      notes.push(`Two slots were picked without seeing each other. LWW keeps ${win.value} and drops ${lose.value}.`);
    }
  }
  const naive: Naive = { eggs: Math.max(dst.naive.eggs, src.naive.eggs), items: ITEMS.filter((e) => dst.naive.items.includes(e) || src.naive.items.includes(e)) };
  const r: Replica = { ...dst, doc: merged, naive };
  let next = setNode({ ...st, lost }, to, r);
  if (resurrected(r).length) {
    got.add("resurrect");
    notes.push(`The naive union brings back ${resurrected(r).join(", ")}, which was removed.`);
  }
  if (pnValue(merged.eggs) < 0) {
    got.add("negative");
    notes.push("Two offline decrements of the last egg add up: the count is negative, and no merge can prevent it.");
  }
  const text = changed ? (notes.join(" ") || `${NODES[to]} merged what ${NODES[from]} had.`) : `${NODES[to]} already had everything ${NODES[from]} sent. The merge changed nothing: idempotent.`;
  next = { ...next, syncs: [...st.syncs, { from, to, changed, text }] };
  return { ...next, done: (["concurrent-inc", "resurrect", "add-wins", "lww-lost", "negative"] as Challenge[]).filter((c) => got.has(c)) };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "inc": {
      const r = st.nodes[a.node];
      const p = [...r.doc.eggs.p] as Vec; p[a.node]++;
      return setNode(st, a.node, edit(r, { eggs: { ...r.doc.eggs, p } }, { eggs: r.naive.eggs + 1 }));
    }
    case "dec": {
      const r = st.nodes[a.node];
      if (eggs(r) <= 0) return st; // the local check passes or fails on local knowledge only
      const n = [...r.doc.eggs.n] as Vec; n[a.node]++;
      return setNode(st, a.node, edit(r, { eggs: { ...r.doc.eggs, n } }, { eggs: r.naive.eggs - 1 }));
    }
    case "add": {
      const r = st.nodes[a.node];
      if (items(r).includes(a.item)) return st;
      const seq = r.seq + 1;
      const adds = byTagOrder([...r.doc.items.adds, { e: a.item, tag: `${NODES[a.node]}${seq}` }]);
      const next = edit(r, { items: { ...r.doc.items, adds } }, { items: ITEMS.filter((e) => e === a.item || r.naive.items.includes(e)) });
      return setNode(st, a.node, { ...next, seq });
    }
    case "remove": {
      const r = st.nodes[a.node];
      const dead = new Set(r.doc.items.removed);
      const seen = r.doc.items.adds.filter((t) => t.e === a.item && !dead.has(t.tag)).map((t) => t.tag);
      if (!seen.length) return st;
      return setNode(st, a.node, edit(r, { items: { ...r.doc.items, removed: uniq([...r.doc.items.removed, ...seen]) } }, { items: r.naive.items.filter((e) => e !== a.item) }));
    }
    case "slot": {
      const r = st.nodes[a.node];
      if (r.doc.slot.value === a.value) return st;
      const clock = r.doc.clock + 1;
      const seq = r.seq + 1;
      const slot: Reg = { value: a.value, ts: [clock, a.node], id: `${NODES[a.node]}${seq}`, history: uniq([...r.doc.slot.history, r.doc.slot.id]) };
      return setNode(st, a.node, { ...edit(r, { slot, clock }, {}), seq });
    }
    case "sync":
      return syncOne(st, a.from, a.to);
    case "syncAll": {
      // One gossip round in each direction: enough for three replicas to converge.
      let s = st;
      for (const [f, t] of [[0, 1], [1, 2], [2, 0], [0, 1], [1, 2]] as [NodeId, NodeId][]) s = syncOne(s, f, t);
      return s;
    }
  }
}
