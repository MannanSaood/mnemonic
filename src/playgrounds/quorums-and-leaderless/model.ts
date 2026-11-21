// Quorum playground: N home replicas for one shopping-cart key, two spare nodes, R and W sliders.
//
// After this, the reader can answer: why does R + W > N make a read see the latest successful
// write, and which three things (sloppy quorums, failed writes left behind, concurrent writes)
// still return a surprising answer when R + W > N holds?
//
// Every write gets a generation number; a higher generation replaces a lower one. Two clients
// writing at once produce two records with the same generation (concurrent). A replica keeps the
// newest generation it has seen: with last-write-wins it keeps one record (highest timestamp),
// with siblings it keeps every concurrent record. That is how Cassandra (LWW per cell) and
// Dynamo or Riak (version vectors, siblings) differ, reduced to what this lesson needs.
//
// Reads ask R of the target replicas. "worst" makes the stalest replicas answer first, which is
// what a guarantee has to survive; "rotate" spreads reads round-robin.
//
// Plain state + a pure step function, so it can be tested without a browser.

export interface Rec {
  gen: number;
  label: string;
  /** Wall-clock timestamp from the writing client, used by last-write-wins. */
  ts: number;
  client: "laptop" | "phone";
  /** Was the write reported as successful to the client? */
  acked: boolean;
  /** Set on a spare: the home replica this record is waiting to be handed to. */
  hintFor?: number;
}

export interface Replica { id: number; spare: boolean; up: boolean; recs: Rec[] }

export type Resolve = "lww" | "siblings";
export type Answer = "worst" | "rotate";

export interface ReadResult {
  ok: boolean;
  from: number[];
  recs: Rec[];
  stale: boolean;
  ghost: boolean;
  /** R + W > N at the time of the read. */
  overlap: boolean;
  sloppy: boolean;
}

export interface WriteResult { ok: boolean; to: number[]; label: string; concurrent: boolean; lost?: string }

export type Challenge = "stale" | "fresh" | "sloppy" | "ghost" | "lost";

export interface Stats { writes: number; failedWrites: number; reads: number; staleReads: number; unavailableReads: number; ghostReads: number; lost: number; overlapStale: number }

export interface State {
  n: number;
  r: number;
  w: number;
  sloppy: boolean;
  resolve: Resolve;
  answer: Answer;
  nodes: Replica[];
  gen: number;
  /** Highest generation that was acknowledged to a client. */
  ackedGen: number;
  clock: number;
  rr: number;
  item: number;
  lastWrite: WriteResult | null;
  lastRead: ReadResult | null;
  stats: Stats;
  done: Challenge[];
}

export type Action =
  | { type: "config"; n?: number; r?: number; w?: number }
  | { type: "sloppy"; on: boolean }
  | { type: "resolve"; mode: Resolve }
  | { type: "answer"; mode: Answer }
  | { type: "toggle"; id: number }
  | { type: "write" }
  | { type: "concurrent" }
  | { type: "read" }
  | { type: "handoff" }
  | { type: "reset" };

export const SPARES = 2;
export const ITEMS = ["book", "lamp", "mug", "pen", "desk", "chair", "kettle", "rug", "clock", "plant"];
/** The phone's clock runs this many ms behind the laptop's. */
export const PHONE_SKEW = 40;

const zero = (): Stats => ({ writes: 0, failedWrites: 0, reads: 0, staleReads: 0, unavailableReads: 0, ghostReads: 0, lost: 0, overlapStale: 0 });

function nodesFor(n: number): Replica[] {
  const base: Rec = { gen: 0, label: "empty cart", ts: 0, client: "laptop", acked: true };
  return [
    ...Array.from({ length: n }, (_, i) => ({ id: i + 1, spare: false, up: true, recs: [base] })),
    ...Array.from({ length: SPARES }, (_, i) => ({ id: n + i + 1, spare: true, up: true, recs: [] as Rec[] })),
  ];
}

export function init(): State {
  return {
    n: 3, r: 2, w: 2, sloppy: false, resolve: "lww", answer: "worst",
    nodes: nodesFor(3), gen: 0, ackedGen: 0, clock: 1000, rr: 0, item: 0,
    lastWrite: null, lastRead: null, stats: zero(), done: [],
  };
}

export const overlaps = (st: State) => st.r + st.w > st.n;
export const homes = (st: State) => st.nodes.filter((x) => !x.spare);

/** The newest generation a set of records holds, and the records of that generation. */
export function newest(recs: Rec[], resolve: Resolve): Rec[] {
  if (!recs.length) return [];
  const g = Math.max(...recs.map((x) => x.gen));
  const top = recs.filter((x) => x.gen === g);
  const uniq = top.filter((x, i) => top.findIndex((y) => y.label === x.label) === i);
  if (resolve === "lww") return [uniq.reduce((a, b) => (b.ts > a.ts ? b : a))];
  return uniq;
}

const maxGen = (recs: Rec[]) => (recs.length ? Math.max(...recs.map((x) => x.gen)) : -1);

/** Store records on a replica: keep only the newest generation (one record under LWW). */
function store(node: Replica, add: Rec[], resolve: Resolve): Replica {
  const home = node.recs.filter((x) => x.hintFor === undefined);
  const hinted = node.recs.filter((x) => x.hintFor !== undefined);
  if (node.spare) return { ...node, recs: [...hinted, ...add] };
  return { ...node, recs: newest([...home, ...add], resolve) };
}

/** Replicas a request goes to: the up home replicas, or with a sloppy quorum the first N healthy nodes. */
export function targets(st: State): Replica[] {
  if (!st.sloppy) return homes(st).filter((x) => x.up);
  return st.nodes.filter((x) => x.up).slice(0, st.n);
}

function doWrite(st: State, recs: Omit<Rec, "acked">[], concurrent: boolean): State {
  const to = targets(st);
  const ok = to.length >= st.w;
  const downHomes = homes(st).filter((x) => !x.up).map((x) => x.id);
  let hintIdx = 0;
  const full = recs.map((x) => ({ ...x, acked: ok }));
  const nodes = st.nodes.map((node) => {
    if (!to.some((x) => x.id === node.id)) return node;
    if (node.spare) {
      const hintFor = downHomes[hintIdx++];
      if (hintFor === undefined) return node;
      return store(node, full.map((x) => ({ ...x, hintFor })), st.resolve);
    }
    return store(node, full, st.resolve);
  });
  const gen = recs[0].gen;
  let lost: string | undefined;
  if (concurrent && ok && st.resolve === "lww") lost = newest(full, "siblings").reduce((a, b) => (b.ts < a.ts ? b : a)).label;
  const stats = {
    ...st.stats,
    writes: st.stats.writes + recs.length,
    failedWrites: st.stats.failedWrites + (ok ? 0 : recs.length),
    lost: st.stats.lost + (lost ? 1 : 0),
  };
  const lastWrite: WriteResult = { ok, to: to.map((x) => x.id), label: recs.map((x) => x.label).join(" + "), concurrent, lost };
  const next: State = { ...st, nodes, gen, ackedGen: ok ? gen : st.ackedGen, stats, lastWrite, clock: st.clock + 100 };
  return { ...next, done: challenges(next, null) };
}

function doRead(st: State): State {
  const cands = targets(st);
  const sloppyRead = st.sloppy && cands.some((x) => x.spare);
  if (cands.length < st.r) {
    const lastRead: ReadResult = { ok: false, from: [], recs: [], stale: false, ghost: false, overlap: overlaps(st), sloppy: sloppyRead };
    return { ...st, lastRead, stats: { ...st.stats, reads: st.stats.reads + 1, unavailableReads: st.stats.unavailableReads + 1 } };
  }
  let chosen: Replica[];
  if (st.answer === "worst") {
    chosen = [...cands].sort((a, b) => maxGen(a.recs) - maxGen(b.recs) || a.id - b.id).slice(0, st.r);
  } else {
    chosen = Array.from({ length: st.r }, (_, i) => cands[(st.rr + i) % cands.length]);
  }
  const recs = newest(chosen.flatMap((x) => x.recs.map((y) => ({ ...y, hintFor: undefined }))), st.resolve);
  const stale = maxGen(recs) < st.ackedGen;
  const ghost = recs.some((x) => !x.acked);
  const lastRead: ReadResult = { ok: true, from: chosen.map((x) => x.id).sort((a, b) => a - b), recs, stale, ghost, overlap: overlaps(st), sloppy: sloppyRead };
  const stats = {
    ...st.stats,
    reads: st.stats.reads + 1,
    staleReads: st.stats.staleReads + (stale ? 1 : 0),
    ghostReads: st.stats.ghostReads + (ghost ? 1 : 0),
    overlapStale: st.stats.overlapStale + (stale && overlaps(st) ? 1 : 0),
  };
  const next: State = { ...st, lastRead, stats, rr: st.rr + 1 };
  return { ...next, done: challenges(next, cands) };
}

function challenges(st: State, cands: Replica[] | null): Challenge[] {
  const got = new Set(st.done);
  const rd = st.lastRead;
  if (rd?.ok && cands) {
    if (rd.stale && !overlaps(st)) got.add("stale");
    if (rd.stale && overlaps(st) && st.sloppy) got.add("sloppy");
    if (!rd.stale && overlaps(st) && st.answer === "worst" && cands.some((x) => maxGen(x.recs) < st.ackedGen)) got.add("fresh");
    if (rd.ghost) got.add("ghost");
  }
  if (st.lastWrite?.lost) got.add("lost");
  return (["stale", "fresh", "sloppy", "ghost", "lost"] as Challenge[]).filter((c) => got.has(c));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "config": {
      const n = a.n ?? st.n;
      const clamp = (v: number) => Math.max(1, Math.min(n, v));
      const r = clamp(a.r ?? st.r), w = clamp(a.w ?? st.w);
      if (n !== st.n) {
        // A new cluster size is a new cluster: start the data over, keep the settings.
        return { ...st, n, r, w, nodes: nodesFor(n), gen: 0, ackedGen: 0, lastRead: null, lastWrite: null };
      }
      return { ...st, r, w };
    }
    case "sloppy":
      return { ...st, sloppy: a.on };
    case "resolve":
      return { ...st, resolve: a.mode };
    case "answer":
      return { ...st, answer: a.mode };
    case "toggle":
      return { ...st, nodes: st.nodes.map((x) => (x.id === a.id ? { ...x, up: !x.up } : x)) };
    case "write": {
      const label = `+${ITEMS[st.item % ITEMS.length]}`;
      return { ...doWrite(st, [{ gen: st.gen + 1, label, ts: st.clock, client: "laptop" }], false), item: st.item + 1 };
    }
    case "concurrent": {
      const a1 = `+${ITEMS[st.item % ITEMS.length]}`, b1 = `+${ITEMS[(st.item + 1) % ITEMS.length]}`;
      // The phone writes a few ms later, but its clock is behind, so its timestamp is lower.
      return {
        ...doWrite(st, [
          { gen: st.gen + 1, label: a1, ts: st.clock, client: "laptop" },
          { gen: st.gen + 1, label: b1, ts: st.clock + 5 - PHONE_SKEW, client: "phone" },
        ], true),
        item: st.item + 2,
      };
    }
    case "read":
      return doRead(st);
    case "handoff": {
      let nodes = st.nodes;
      for (const spare of st.nodes.filter((x) => x.spare && x.up)) {
        const deliver = spare.recs.filter((x) => x.hintFor !== undefined && nodes.find((y) => y.id === x.hintFor)?.up);
        if (!deliver.length) continue;
        nodes = nodes.map((node) => {
          if (node.id === spare.id) return { ...node, recs: node.recs.filter((x) => !deliver.includes(x)) };
          const mine = deliver.filter((x) => x.hintFor === node.id).map((x) => ({ ...x, hintFor: undefined }));
          return mine.length ? store(node, mine, st.resolve) : node;
        });
      }
      return { ...st, nodes };
    }
  }
}

/** Hints waiting on spares. */
export const pendingHints = (st: State) => st.nodes.filter((x) => x.spare).reduce((k, x) => k + x.recs.filter((y) => y.hintFor !== undefined).length, 0);
export const isStale = (st: State, x: Replica) => !x.spare && maxGen(x.recs) < st.ackedGen;
export { maxGen };
