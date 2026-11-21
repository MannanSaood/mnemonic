// Consistent hashing playground: 1,000 cache keys spread over a fleet of cache servers.
//
// After this, the reader can answer: "When a server joins or leaves, how many keys change
// server with hash % N, how many with a hash ring, and what do virtual nodes add?"
// Core insight: with modulo hashing every key's server depends on N, so changing N moves almost
// every key (N/(N+1) of them on a join); on a ring a join or a leave moves only the keys in the
// arcs that change hands, about 1/N. The ring alone does not balance load: with one point per
// server the arcs are uneven and a dead server's keys all land on one neighbour. Many virtual
// nodes per server even out the arcs and spread a dead server's keys over every survivor.
//
// Every action is applied to both schemes at once (same keys, same servers), so each change is
// a side-by-side counterfactual. Pure and deterministic: the hash is FNV-1a with a final mix.

export const KEYS = 1000;
export const NAMES = ["cache-a", "cache-b", "cache-c", "cache-d", "cache-e", "cache-f", "cache-g", "cache-h"] as const;
export type Server = (typeof NAMES)[number];
export const VNODES = [1, 3, 10, 50, 200] as const;
export type Vnodes = (typeof VNODES)[number];
export const RING = 2 ** 32;

/** 32-bit FNV-1a followed by the murmur3 finaliser, so similar strings land far apart. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const keyName = (i: number) => `user:${i}`;
/** Where each key sits on the ring (computed once). */
export const KEY_HASH: number[] = Array.from({ length: KEYS }, (_, i) => hash32(keyName(i)));

export interface Point { pos: number; server: Server }

/** The ring: every server's virtual-node points, sorted by position. */
export function ringPoints(servers: readonly Server[], vnodes: number): Point[] {
  const pts: Point[] = [];
  for (const s of servers) for (let v = 0; v < vnodes; v++) pts.push({ pos: hash32(`${s}#${v}`), server: s });
  return pts.sort((a, b) => a.pos - b.pos || (a.server < b.server ? -1 : 1));
}

/** First point at or after h, wrapping past the top of the ring to the first point. Binary search. */
export function lookup(points: Point[], h: number): Server {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].pos < h) lo = mid + 1; else hi = mid;
  }
  return points[lo === points.length ? 0 : lo].server;
}

export function ringOwners(servers: readonly Server[], vnodes: number): Server[] {
  const pts = ringPoints(servers, vnodes);
  return KEY_HASH.map((h) => lookup(pts, h));
}

/** The naive scheme: the server list from config, indexed by hash % N. */
export function modOwners(servers: readonly Server[]): Server[] {
  return KEY_HASH.map((h) => servers[h % servers.length]);
}

export function loads(servers: readonly Server[], owners: Server[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(servers.map((s) => [s, 0]));
  for (const o of owners) out[o]++;
  return out;
}

/** Busiest server's keys divided by a fair share (KEYS / N). 1.0 is perfectly even. */
export function busiest(servers: readonly Server[], owners: Server[]): number {
  const l = loads(servers, owners);
  return Math.max(...servers.map((s) => l[s])) / (KEYS / servers.length);
}

export type ChangeKind = "add" | "remove" | "vnodes";

export interface Change {
  id: number;
  kind: ChangeKind;
  server: Server | null;
  /** Server count before and after. */
  from: number;
  to: number;
  vnodes: number;
  modMoved: boolean[];
  ringMoved: boolean[];
  modCount: number;
  ringCount: number;
  /** Where the keys that moved on the ring went, by server. */
  ringTo: Record<string, number>;
}

export const CHALLENGES = [
  { id: "small", text: "Add a server and move fewer than 25% of the keys on the ring." },
  { id: "hot", text: "Find a ring where one server holds at least twice its fair share." },
  { id: "spread", text: "Remove a server and have its keys land on 3 or more survivors." },
  { id: "even", text: "Get the busiest server on the ring within 1.15× its fair share, with 4 or more servers." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  servers: Server[];
  vnodes: Vnodes;
  changes: Change[];
  seq: number;
  prediction: string | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "add" }
  | { type: "remove"; server: Server }
  | { type: "vnodes"; vnodes: Vnodes }
  | { type: "predict"; value: string }
  | { type: "reset" };

export const MIN_SERVERS = 2;

export function init(): State {
  return {
    servers: ["cache-a", "cache-b", "cache-c", "cache-d"],
    vnodes: 1,
    changes: [],
    seq: 1,
    prediction: null,
    done: { small: false, hot: false, spread: false, even: false },
  };
}

export const nextServer = (s: State): Server | null => NAMES.find((n) => !s.servers.includes(n)) ?? null;
export const lastChange = (s: State): Change | null => s.changes[0] ?? null;

function apply(s: State, servers: Server[], vnodes: Vnodes, kind: ChangeKind, server: Server | null): State {
  const m0 = modOwners(s.servers), r0 = ringOwners(s.servers, s.vnodes);
  const m1 = modOwners(servers), r1 = ringOwners(servers, vnodes);
  const modMoved = m0.map((o, i) => o !== m1[i]);
  const ringMoved = r0.map((o, i) => o !== r1[i]);
  const ringTo: Record<string, number> = {};
  ringMoved.forEach((mv, i) => { if (mv) ringTo[r1[i]] = (ringTo[r1[i]] ?? 0) + 1; });
  const change: Change = {
    id: s.seq, kind, server, from: s.servers.length, to: servers.length, vnodes,
    modMoved, ringMoved,
    modCount: modMoved.filter(Boolean).length,
    ringCount: ringMoved.filter(Boolean).length,
    ringTo,
  };
  const next: State = { ...s, servers, vnodes, changes: [change, ...s.changes].slice(0, 8), seq: s.seq + 1 };
  return { ...next, done: score(next, change) };
}

function score(s: State, c: Change): Record<ChallengeId, boolean> {
  const d = { ...s.done };
  const ratio = busiest(s.servers, ringOwners(s.servers, s.vnodes));
  if (c.kind === "add" && c.ringCount < 0.25 * KEYS) d.small = true;
  if (ratio >= 2) d.hot = true;
  if (c.kind === "remove" && Object.keys(c.ringTo).length >= 3) d.spread = true;
  if (s.servers.length >= 4 && ratio <= 1.15) d.even = true;
  return d;
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "add": {
      const n = nextServer(s);
      return n ? apply(s, [...s.servers, n], s.vnodes, "add", n) : s;
    }
    case "remove":
      if (!s.servers.includes(a.server) || s.servers.length <= MIN_SERVERS) return s;
      return apply(s, s.servers.filter((x) => x !== a.server), s.vnodes, "remove", a.server);
    case "vnodes":
      return a.vnodes === s.vnodes ? s : apply(s, s.servers, a.vnodes, "vnodes", null);
  }
}

/** Initial ratio check, so a ring that is already lopsided at load counts for "hot". */
export function currentRatio(s: State): number {
  return busiest(s.servers, ringOwners(s.servers, s.vnodes));
}
