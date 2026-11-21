// Hash tables playground: a render cache's key table, built two ways.
//
// After this, the reader can answer: "What does a hash table lookup actually cost, and what
// turns O(1) into O(n)?"
// Core insight: a lookup costs one hash plus the slots it reads. That stays at one or two
// while (1) the hash spreads the keys and (2) the load factor is capped by resizing. A hash
// that ignores part of the key, or keys crafted against a weak hash, pile every key into one
// bucket; linear probing past about 85% full makes misses read dozens of slots; resizing keeps
// the average cheap but each resize moves every key at once. Open-addressing deletes need a
// tombstone, or keys further along the probe run become unreachable.
//
// Pure and deterministic. Keys are "tenant/path" strings from a render cache.

export type Strategy = "chain" | "probe";
export type HashKind = "full" | "tenant" | "sum";
export type Source = "mixed" | "big" | "crafted";
export type MaxLoad = "0.5" | "0.75" | "0.9" | "none";

export const TOMB = "\u0000tomb";
export type Slot = string | null;

export const MIN_SLOTS = 8;
export const MAX_KEYS = 240;
export const SAMPLE = 128;

export const TENANTS = ["acme", "globex", "initech", "umbrella", "hooli", "vandelay"] as const;

/** 32-bit FNV-1a with a seed, followed by the murmur3 finaliser. */
export function fnv(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const tenantOf = (key: string) => key.slice(0, key.indexOf("/"));

/** The three hash functions the reader can pick. */
export function hashOf(kind: HashKind, key: string): number {
  if (kind === "full") return fnv(key, 0x9e3779b9);
  if (kind === "tenant") return fnv(tenantOf(key), 0x9e3779b9); // the lesson's bug: path ignored
  let s = 0; // the textbook weak hash: add up the character codes
  for (let i = 0; i < key.length; i++) s += key.charCodeAt(i);
  return s;
}

/** The i-th permutation of a string (factorial number system). Same characters, same sum. */
function permutation(chars: string, i: number): string {
  const pool = chars.split("");
  let out = "";
  for (let n = pool.length; n > 0; n--) {
    let f = 1;
    for (let j = 2; j < n; j++) f *= j;
    const idx = Math.floor(i / f) % n;
    out += pool.splice(idx, 1)[0];
    i %= f;
  }
  return out;
}

/** The i-th key from a traffic source. Never repeats within a source. */
export function keyFor(src: Source, i: number): string {
  if (src === "mixed") return `${TENANTS[i % TENANTS.length]}/p/${1000 + ((i * 7919) % 9000)}`;
  if (src === "big") return `acme/p/${1000 + ((i * 3571) % 9000)}`;
  // Crafted against the sum-of-codes hash: every key is a reordering of the same digits.
  return `acme/p/${permutation("1042983", (i * 13) % 5040)}`;
}

export type Table = { strategy: Strategy; hash: HashKind; m: number; chains: string[][]; slots: Slot[] };

export const home = (t: Table, key: string) => hashOf(t.hash, key) & (t.m - 1);

export function emptyTable(strategy: Strategy, hash: HashKind, m: number): Table {
  return { strategy, hash, m, chains: Array.from({ length: m }, () => []), slots: Array(m).fill(null) };
}

export interface Probe { found: boolean; path: number[]; cost: number }

/** Look a key up. cost = keys compared (chaining) or slots read (open addressing). */
export function lookup(t: Table, key: string): Probe {
  const h = home(t, key);
  if (t.strategy === "chain") {
    const c = t.chains[h];
    const at = c.indexOf(key);
    return { found: at >= 0, path: [h], cost: at >= 0 ? at + 1 : c.length };
  }
  const path: number[] = [];
  for (let i = 0; i < t.m; i++) {
    const j = (h + i) & (t.m - 1);
    path.push(j);
    const s = t.slots[j];
    if (s === null) return { found: false, path, cost: path.length };
    if (s === key) return { found: true, path, cost: path.length };
  }
  return { found: false, path, cost: path.length };
}

/** Put a key that is not in the table. Returns the slots touched, or null if no slot is free. */
function place(t: Table, key: string): { path: number[]; cost: number } | null {
  const h = home(t, key);
  if (t.strategy === "chain") {
    const cost = t.chains[h].length + 1; // compare against every key in the chain, then append
    t.chains[h] = [...t.chains[h], key];
    return { path: [h], cost };
  }
  const path: number[] = [];
  for (let i = 0; i < t.m; i++) {
    const j = (h + i) & (t.m - 1);
    path.push(j);
    if (t.slots[j] === null || t.slots[j] === TOMB) {
      t.slots = t.slots.slice();
      t.slots[j] = key;
      return { path, cost: path.length };
    }
  }
  return null;
}

export function build(strategy: Strategy, hash: HashKind, m: number, keys: string[]): Table {
  const t = emptyTable(strategy, hash, m);
  for (const k of keys) place(t, k);
  return t;
}

export const tombstones = (t: Table) => (t.strategy === "probe" ? t.slots.filter((s) => s === TOMB).length : 0);
export const loadLimit = (ml: MaxLoad) => (ml === "none" ? Infinity : Number(ml));

export type OpKind = "insert" | "find" | "delete" | "full";
export interface Op { kind: OpKind; key: string; path: number[]; cost: number; found: boolean; resized: null | { from: number; to: number; moved: number } }

export const CHALLENGES = [
  { id: "pileup", text: "Pile 16 keys onto one home slot." },
  { id: "slowMiss", text: "Make a miss read 10 or more slots on average (open addressing)." },
  { id: "lost", text: "Lose a key: it is still stored, but a lookup can no longer find it." },
  { id: "fast", text: "Hold 48 keys with hits under 1.5 and misses under 2 slots on average." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  strategy: Strategy;
  maxLoad: MaxLoad;
  hash: HashKind;
  source: Source;
  tombstones: boolean;
  table: Table;
  keys: string[];
  next: Record<Source, number>;
  inserts: number;
  resizes: number;
  moved: number;
  worst: number;
  last: Op | null;
  selected: number | null;
  prediction: string | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "insert"; n: number }
  | { type: "strategy"; value: Strategy }
  | { type: "maxLoad"; value: MaxLoad }
  | { type: "hash"; value: HashKind }
  | { type: "source"; value: Source }
  | { type: "tombstones"; value: boolean }
  | { type: "select"; slot: number | null }
  | { type: "find"; key: string }
  | { type: "delete"; key: string }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    strategy: "probe", maxLoad: "0.75", hash: "full", source: "mixed", tombstones: true,
    table: emptyTable("probe", "full", MIN_SLOTS), keys: [],
    next: { mixed: 0, big: 0, crafted: 0 },
    inserts: 0, resizes: 0, moved: 0, worst: 0, last: null, selected: null, prediction: null,
    done: { pileup: false, slowMiss: false, lost: false, fast: false },
  };
}

/* ---------------- measurements ---------------- */

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const load = (s: State) => s.keys.length / s.table.m;

/** Average cost of finding each stored key. */
export const avgHit = (s: State) => mean(s.keys.map((k) => lookup(s.table, k).cost));

/** Keys the same traffic will ask for next, which are not in the table: the cost of a miss. */
export function missSample(s: State): string[] {
  const out: string[] = [];
  for (let i = s.next[s.source]; out.length < SAMPLE; i++) out.push(keyFor(s.source, i));
  return out;
}
export const avgMiss = (s: State) => mean(missSample(s).map((k) => lookup(s.table, k).cost));

/** Cost of finding each stored key, as a histogram: index = cost, capped at 10 (10+). */
export function hitHistogram(s: State): number[] {
  const h = Array(11).fill(0);
  for (const k of s.keys) h[Math.min(10, lookup(s.table, k).cost)]++;
  return h;
}

/** Largest number of stored keys whose hash picks the same home slot. */
export function maxPile(s: State): number {
  const c = new Map<number, number>();
  let best = 0;
  for (const k of s.keys) {
    const h = home(s.table, k);
    const n = (c.get(h) ?? 0) + 1;
    c.set(h, n);
    best = Math.max(best, n);
  }
  return best;
}

/** Longest chain (chaining) or longest run of occupied or tombstoned slots (probing). */
export function longest(s: State): number {
  const t = s.table;
  if (t.strategy === "chain") return Math.max(0, ...t.chains.map((c) => c.length));
  if (t.slots.every((x) => x !== null)) return t.m;
  let best = 0, run = 0;
  const start = t.slots.indexOf(null);
  for (let i = 1; i <= t.m; i++) {
    const x = t.slots[(start + i) % t.m];
    run = x === null ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Stored keys that a lookup can no longer reach. */
export const lostKeys = (s: State) => s.keys.filter((k) => !lookup(s.table, k).found);

/** Textbook expectations under uniform hashing (CLRS 11.2, 11.4; Knuth for linear probing). */
export function theory(strategy: Strategy, a: number): { hit: number; miss: number } {
  if (strategy === "chain") return { hit: 1 + a / 2, miss: a };
  if (a >= 1) return { hit: Infinity, miss: Infinity };
  return { hit: 0.5 * (1 + 1 / (1 - a)), miss: 0.5 * (1 + 1 / (1 - a) ** 2) };
}

/* ---------------- step ---------------- */

/** Smallest power-of-two size that keeps keys under the load cap (and fits them all). */
function sizeFor(n: number, ml: MaxLoad, strategy: Strategy, from: number): number {
  let m = from;
  const cap = loadLimit(ml);
  while ((cap !== Infinity && n / m > cap) || (strategy === "probe" && n > m)) m *= 2;
  return m;
}

function rebuild(s: State, patch: Partial<State>): State {
  const n = { ...s, ...patch };
  // "No resizing" keeps the current size; any other cap rebuilds at the smallest size that fits.
  const m = sizeFor(n.keys.length, n.maxLoad, n.strategy, n.maxLoad === "none" ? s.table.m : MIN_SLOTS);
  return score({
    ...n, table: build(n.strategy, n.hash, m, n.keys),
    resizes: 0, moved: 0, worst: 0, inserts: 0, last: null, selected: null,
  });
}

function insertOne(s: State): State {
  if (s.keys.length >= MAX_KEYS) return s;
  const key = keyFor(s.source, s.next[s.source]);
  let t = s.table;
  let resized: Op["resized"] = null;
  const used = s.keys.length + tombstones(t) + 1;
  if (used / t.m > loadLimit(s.maxLoad)) {
    const to = t.m * 2;
    resized = { from: t.m, to, moved: s.keys.length };
    t = build(s.strategy, s.hash, to, s.keys); // every key is rehashed into the new array
  } else {
    t = { ...t, chains: t.chains.slice(), slots: t.slots.slice() };
  }
  const p = place(t, key);
  if (!p) return { ...s, last: { kind: "full", key, path: [], cost: t.m, found: false, resized: null } };
  const work = p.cost + (resized?.moved ?? 0);
  return {
    ...s, table: t, keys: [...s.keys, key],
    next: { ...s.next, [s.source]: s.next[s.source] + 1 },
    inserts: s.inserts + 1,
    resizes: s.resizes + (resized ? 1 : 0),
    moved: s.moved + (resized?.moved ?? 0),
    worst: Math.max(s.worst, work),
    last: { kind: "insert", key, path: p.path, cost: p.cost, found: true, resized },
  };
}

function remove(s: State, key: string): State {
  const t = { ...s.table, chains: s.table.chains.slice(), slots: s.table.slots.slice() };
  const p = lookup(t, key);
  if (!p.found) return s;
  const at = p.path[p.path.length - 1];
  if (t.strategy === "chain") t.chains[at] = t.chains[at].filter((k) => k !== key);
  else t.slots[at] = s.tombstones ? TOMB : null; // without a tombstone, the probe run is cut here
  return { ...s, table: t, keys: s.keys.filter((k) => k !== key), last: { kind: "delete", key, path: p.path, cost: p.cost, found: true, resized: null } };
}

function score(s: State): State {
  const d = { ...s.done };
  if (maxPile(s) >= 16) d.pileup = true;
  if (s.strategy === "probe" && s.keys.length >= 8 && avgMiss(s) >= 10) d.slowMiss = true;
  if (lostKeys(s).length > 0) d.lost = true;
  if (s.keys.length >= 48 && avgHit(s) < 1.5 && avgMiss(s) < 2) d.fast = true;
  return { ...s, done: d };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "insert": {
      let n = s;
      for (let i = 0; i < a.n; i++) n = insertOne(n);
      return score(n);
    }
    case "strategy":
      return a.value === s.strategy ? s : rebuild(s, { strategy: a.value });
    case "maxLoad":
      return a.value === s.maxLoad ? s : rebuild(s, { maxLoad: a.value });
    case "hash":
      return a.value === s.hash ? s : rebuild(s, { hash: a.value });
    case "tombstones":
      return { ...s, tombstones: a.value };
    case "source":
      return { ...s, source: a.value };
    case "select":
      return { ...s, selected: a.slot };
    case "find": {
      const p = lookup(s.table, a.key);
      return { ...s, last: { kind: "find", key: a.key, path: p.path, cost: p.cost, found: p.found, resized: null } };
    }
    case "delete":
      return score(remove(s, a.key));
  }
}

/** Keys shown in one slot: the chain, or the single key (tombstones excluded). */
export function keysAt(t: Table, slot: number): string[] {
  if (t.strategy === "chain") return t.chains[slot] ?? [];
  const x = t.slots[slot];
  return x && x !== TOMB ? [x] : [];
}
