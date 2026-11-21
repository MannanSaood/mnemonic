// B+-tree playground: two primary-key indexes side by side, fed the same number of inserts.
//
// After this, the reader can answer: why does a lookup touch only a handful of pages however many
// rows there are, and why do random keys (UUIDv4) split pages all over the index and leave them
// emptier, while time-ordered keys (bigint identity, UUIDv7) only ever touch the right edge?
//
// The tree is small on purpose: a leaf page holds LEAF_CAP keys and an internal page holds
// INTERNAL_CAP children, so splits and new levels show up after tens of inserts instead of
// hundreds of thousands. Real 8 KB pages hold a few hundred entries; `realHeight` does that sum.
//
// Split rules:
//   "half"      the textbook rule: an overflowing page splits into two halves.
//   "rightEdge" what PostgreSQL and InnoDB do for the rightmost page of a level: the left page
//               stays nearly full (PostgreSQL fills it to the index fillfactor, 90 by default),
//               because ascending keys will never come back to it.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type KeyKind = "serial" | "v7" | "v4";
export type SplitRule = "half" | "rightEdge";
export type Challenge = "grow" | "halfEmpty" | "scatter" | "shallow";

export const LEAF_CAP = 8;
export const INTERNAL_CAP = 8;
/** On a right-edge split the left page keeps this many entries (90% of 8, rounded down). */
export const RIGHT_KEEP = 7;
/** Sliding window for "distinct leaf pages written by the last N inserts". */
export const WINDOW = 100;
export const MAX_KEYS = 5000;
/** Number of keys a range scan returns. */
export const RANGE = 40;

export interface Node { id: number; leaf: boolean; keys: number[]; kids: number[]; next: number | null }

export interface Tree {
  kind: KeyKind;
  nodes: Record<number, Node>;
  root: number;
  nextId: number;
  height: number;
  count: number;
  splits: number;
  rootSplits: number;
  /** Generator clock for serial and v7 keys. */
  clock: number;
  /** For each of the last WINDOW inserts, the leaf pages it wrote. */
  window: number[][];
  /** Leaves written and pages created by the last batch of inserts. */
  batchWritten: number[];
  batchCreated: number[];
  batchSplits: number;
  /** The path of the last single insert or lookup, root first. */
  path: number[];
  lastKey: number | null;
}

export interface Lookup { key: number; path: number[]; found: boolean; leavesWalked: number; range: boolean }

export interface State {
  seed: number;
  rule: SplitRule;
  trees: [Tree, Tree];
  lookups: [Lookup | null, Lookup | null];
  inserted: number;
  lookupsDone: number;
  done: Challenge[];
}

export type Action =
  | { type: "insert"; n: number }
  | { type: "kind"; lane: 0 | 1; kind: KeyKind }
  | { type: "rule"; rule: SplitRule }
  | { type: "lookup"; range?: boolean }
  | { type: "reset" };

/* ---------------- random numbers (mulberry32, kept in state) ---------------- */

function rand(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, (seed + 0x6d2b79f5) | 0];
}

/* ---------------- tree ---------------- */

export function emptyTree(kind: KeyKind): Tree {
  return {
    kind, nodes: { 1: { id: 1, leaf: true, keys: [], kids: [], next: null } }, root: 1, nextId: 2,
    height: 1, count: 0, splits: 0, rootSplits: 0, clock: 0, window: [], batchWritten: [], batchCreated: [],
    batchSplits: 0, path: [], lastKey: null,
  };
}

function cloneTree(t: Tree): Tree {
  const nodes: Record<number, Node> = {};
  for (const id in t.nodes) {
    const n = t.nodes[id];
    nodes[id] = { ...n, keys: [...n.keys], kids: [...n.kids] };
  }
  return { ...t, nodes, window: [...t.window], batchWritten: [], batchCreated: [], batchSplits: 0 };
}

/** Index of the child to follow: the number of separators that are <= k. */
function childIndex(seps: number[], k: number): number {
  let lo = 0, hi = seps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seps[mid] <= k) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function lowerBound(keys: number[], k: number): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < k) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Root-to-leaf descent. Returns the page ids visited and whether each was the rightmost of its level. */
export function descend(t: Tree, k: number): { path: number[]; rightmost: boolean[] } {
  const path = [t.root];
  const rightmost = [true];
  let node = t.nodes[t.root];
  while (!node.leaf) {
    const i = childIndex(node.keys, k);
    rightmost.push(rightmost[rightmost.length - 1] && i === node.kids.length - 1);
    node = t.nodes[node.kids[i]];
    path.push(node.id);
  }
  return { path, rightmost };
}

/** How many entries the left page keeps when `total` entries must be split in two. */
export function splitAt(total: number, rule: SplitRule, rightmost: boolean, cap: number): number {
  if (rule === "rightEdge" && rightmost) return Math.min(total - 1, cap === LEAF_CAP ? RIGHT_KEEP : cap - 1);
  return Math.floor(total / 2);
}

/** Insert one key into a cloned tree (mutates it). Returns the leaf pages written. */
function insertKey(t: Tree, k: number, rule: SplitRule): number[] {
  const { path, rightmost } = descend(t, k);
  t.path = path;
  t.lastKey = k;
  const leaf = t.nodes[path[path.length - 1]];
  const at = lowerBound(leaf.keys, k);
  if (leaf.keys[at] === k) return [leaf.id]; // duplicate: a unique index would reject it
  leaf.keys.splice(at, 0, k);
  t.count++;
  const written = [leaf.id];
  if (leaf.keys.length <= LEAF_CAP) return written;

  // Leaf split: move the upper part to a new page, link it in, copy its first key up.
  const keep = splitAt(leaf.keys.length, rule, rightmost[rightmost.length - 1], LEAF_CAP);
  const right: Node = { id: t.nextId++, leaf: true, keys: leaf.keys.slice(keep), kids: [], next: leaf.next };
  leaf.keys = leaf.keys.slice(0, keep);
  leaf.next = right.id;
  t.nodes[right.id] = right;
  t.splits++; t.batchSplits++;
  t.batchCreated.push(right.id);
  written.push(right.id);
  let sep = right.keys[0];
  let newChild = right.id;

  // Walk back up: insert the separator into each parent, splitting parents that overflow.
  for (let level = path.length - 2; level >= 0; level--) {
    const parent = t.nodes[path[level]];
    const i = childIndex(parent.keys, sep);
    parent.keys.splice(i, 0, sep);
    parent.kids.splice(i + 1, 0, newChild);
    if (parent.kids.length <= INTERNAL_CAP) return written;
    const keepKids = splitAt(parent.kids.length, rule, rightmost[level], INTERNAL_CAP);
    const up = parent.keys[keepKids - 1];
    const sib: Node = { id: t.nextId++, leaf: false, keys: parent.keys.slice(keepKids), kids: parent.kids.slice(keepKids), next: null };
    parent.keys = parent.keys.slice(0, keepKids - 1);
    parent.kids = parent.kids.slice(0, keepKids);
    t.nodes[sib.id] = sib;
    t.splits++; t.batchSplits++;
    t.batchCreated.push(sib.id);
    sep = up;
    newChild = sib.id;
  }
  // The root itself split: the only way the tree gets taller.
  const root: Node = { id: t.nextId++, leaf: false, keys: [sep], kids: [t.root, newChild], next: null };
  t.nodes[root.id] = root;
  t.root = root.id;
  t.height++;
  t.rootSplits++;
  t.batchCreated.push(root.id);
  return written;
}

/** The next key of a kind. serial: 1, 2, 3... v7: millisecond clock from three app servers with
 *  slightly different clocks, plus random low bits. v4: 32 random bits. */
function nextKey(t: Tree, seed: number): [number, number] {
  if (t.kind === "serial") { t.clock++; return [t.clock, seed]; }
  if (t.kind === "v7") {
    t.clock++;
    const [a, s1] = rand(seed);
    const [b, s2] = rand(s1);
    const skew = Math.floor(a * 3) * 2; // three servers, 0, 2 or 4 ms apart
    return [(t.clock + skew) * 1048576 + Math.floor(b * 1048576), s2];
  }
  const [a, s1] = rand(seed);
  return [Math.floor(a * 4294967296), s1];
}

function insertMany(t0: Tree, n: number, rule: SplitRule, seed: number): [Tree, number] {
  const t = cloneTree(t0);
  const written = new Set<number>();
  let s = seed;
  for (let i = 0; i < n && t.count < MAX_KEYS; i++) {
    let k: number;
    [k, s] = nextKey(t, s);
    const w = insertKey(t, k, rule);
    w.forEach((id) => written.add(id));
    t.window.push(w);
    if (t.window.length > WINDOW) t.window.shift();
  }
  t.batchWritten = [...written];
  return [t, s];
}

/* ---------------- reading the tree ---------------- */

/** Page ids per level, root first, left to right. */
export function levels(t: Tree): number[][] {
  const out: number[][] = [[t.root]];
  while (!t.nodes[out[out.length - 1][0]].leaf) out.push(out[out.length - 1].flatMap((id) => t.nodes[id].kids));
  return out;
}

export function leafCount(t: Tree): number { return levels(t)[t.height - 1].length; }
export function pageCount(t: Tree): number { return Object.keys(t.nodes).length; }
/** Average leaf fill, 0..1. */
export function avgFill(t: Tree): number { return t.count ? t.count / (leafCount(t) * LEAF_CAP) : 0; }
/** Distinct leaf pages written by the last WINDOW inserts. */
export function spread(t: Tree): number { return new Set(t.window.flat()).size; }

export function search(t: Tree, k: number, range: boolean): Lookup {
  const { path } = descend(t, k);
  const leaf = t.nodes[path[path.length - 1]];
  const found = leaf.keys.includes(k);
  let leavesWalked = 0;
  if (range) {
    // Collect RANGE keys starting at k by following the leaf chain, never going back up.
    let got = leaf.keys.length - lowerBound(leaf.keys, k);
    let next = leaf.next;
    while (got < RANGE && next !== null) {
      leavesWalked++;
      got += t.nodes[next].keys.length;
      next = t.nodes[next].next;
    }
  }
  return { key: k, path, found, leavesWalked, range };
}

/** Pages read by a lookup: one per level, plus extra leaves for a range scan. */
export const pagesRead = (l: Lookup) => l.path.length + l.leavesWalked;

/** Height of a real index: rows entries, perPage entries per leaf and per internal page. */
export function realHeight(rows: number, perPage: number): number {
  let pages = Math.ceil(rows / perPage), h = 1;
  while (pages > 1) { pages = Math.ceil(pages / perPage); h++; }
  return h;
}

const timeOrdered = (k: KeyKind) => k !== "v4";

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  for (const t of st.trees) {
    if (t.height >= 3) got.add("grow");
    if (timeOrdered(t.kind) && st.rule === "half" && t.count >= 200 && avgFill(t) <= 0.6) got.add("halfEmpty");
    if (t.kind === "v4" && t.window.length >= WINDOW && spread(t) >= 40) got.add("scatter");
  }
  st.lookups.forEach((l, i) => { if (l && st.trees[i].count >= 1000 && pagesRead(l) <= 5) got.add("shallow"); });
  return (["grow", "halfEmpty", "scatter", "shallow"] as Challenge[]).filter((c) => got.has(c));
}

export function init(): State {
  return { seed: 42, rule: "rightEdge", trees: [emptyTree("v7"), emptyTree("v4")], lookups: [null, null], inserted: 0, lookupsDone: 0, done: [] };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "insert": {
      let seed = st.seed;
      const trees = st.trees.map((t) => {
        const [nt, s] = insertMany(t, a.n, st.rule, seed);
        seed = s;
        return nt;
      }) as [Tree, Tree];
      const next = { ...st, trees, seed, lookups: [null, null] as State["lookups"], inserted: st.inserted + a.n };
      return { ...next, done: challenges(next) };
    }
    case "kind": {
      const trees = [...st.trees] as [Tree, Tree];
      trees[a.lane] = emptyTree(a.kind);
      const lookups = [...st.lookups] as State["lookups"];
      lookups[a.lane] = null;
      return { ...st, trees, lookups };
    }
    case "rule":
      // A different split rule is a different index: rebuild both from empty.
      return { ...st, rule: a.rule, trees: [emptyTree(st.trees[0].kind), emptyTree(st.trees[1].kind)], lookups: [null, null] };
    case "lookup": {
      let seed = st.seed;
      const lookups = st.trees.map((t) => {
        if (!t.count) return null;
        const all = levels(t)[t.height - 1].flatMap((id) => t.nodes[id].keys);
        const [r, s] = rand(seed);
        seed = s;
        return search(t, all[Math.floor(r * all.length)], !!a.range);
      }) as State["lookups"];
      const next = { ...st, lookups, seed, lookupsDone: st.lookupsDone + 1 };
      return { ...next, done: challenges(next) };
    }
  }
}

/** A short display form of a key. */
export function showKey(kind: KeyKind, k: number): string {
  if (kind === "serial") return String(k);
  if (kind === "v7") return `0195${Math.floor(k / 1048576).toString(16).padStart(5, "0")}…`;
  return `${k.toString(16).padStart(8, "0")}…`;
}

/** Check the B+-tree invariants: sorted keys, separators bound their subtrees, all leaves at one depth, chain in order. */
export function checkInvariants(t: Tree): string | null {
  const lv = levels(t);
  if (lv.length !== t.height) return "height does not match the levels";
  const bad = (id: number, lo: number, hi: number, depth: number): string | null => {
    const n = t.nodes[id];
    for (let i = 1; i < n.keys.length; i++) if (n.keys[i - 1] >= n.keys[i]) return `page ${id} keys out of order`;
    if (n.keys.some((k) => k < lo || k >= hi)) return `page ${id} has a key outside its separators`;
    if (n.leaf) return depth === t.height - 1 ? null : `leaf ${id} at the wrong depth`;
    if (n.kids.length !== n.keys.length + 1) return `page ${id} has ${n.kids.length} children for ${n.keys.length} separators`;
    if (n.kids.length > INTERNAL_CAP) return `page ${id} overflows`;
    for (let i = 0; i < n.kids.length; i++) {
      const e = bad(n.kids[i], i === 0 ? lo : n.keys[i - 1], i === n.keys.length ? hi : n.keys[i], depth + 1);
      if (e) return e;
    }
    return null;
  };
  const e = bad(t.root, -Infinity, Infinity, 0);
  if (e) return e;
  const leaves = lv[lv.length - 1];
  for (let i = 0; i < leaves.length; i++) {
    if (t.nodes[leaves[i]].keys.length > LEAF_CAP) return `leaf ${leaves[i]} overflows`;
    if (t.nodes[leaves[i]].next !== (leaves[i + 1] ?? null)) return `leaf chain broken at ${leaves[i]}`;
  }
  const total = leaves.reduce((k, id) => k + t.nodes[id].keys.length, 0);
  return total === t.count ? null : "key count mismatch";
}
