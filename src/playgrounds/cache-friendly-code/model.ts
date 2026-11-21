// Cache lab: a small set-associative cache in front of RAM, and two loops that read the same data.
//
// After this, the reader can answer: why does the same loop over the same data run several times
// slower when it walks columns instead of rows, or reads one field out of an array of structs,
// and why does the order stop mattering once the data fits in the cache?
//
// The cache has 8 sets of 2 ways with 64-byte lines (1 KiB, 16 lines) and LRU replacement.
// An address splits into offset (low 6 bits), set (next 3) and tag (the rest). A hit costs 1 ns,
// a miss goes to DRAM and costs 100 ns. An optional next-line prefetcher (tagged: it fetches line
// L+1 on a miss to L and on the first use of a prefetched line) streams lines in behind a
// sequential walk; a prefetched line costs 8 ns on first use, standing for the bandwidth it took.
// These are model numbers: one cache level, no memory-level parallelism, no TLB.
//
// Workloads: a metrics matrix samples[host][minute] of float64 (16 minutes per host, 8 or 32
// hosts), summed in row order or column order; and 64 order records {id, price, qty, ts}, where
// the loop sums only price, stored as an array of structs or as a struct of arrays.
// The reader steps or runs the loop, or clicks any cell to read it, and compares finished runs.
// Plain state + a pure step function, so it can be tested without a browser.

export const LINE = 64;
export const SETS = 8;
export const WAYS = 2;
export const ELEM = 8;
export const PER_LINE = LINE / ELEM;
export const COLS = 16; // minutes per host in the matrix; 16 floats = 2 lines per row
export const RECORDS = 64;
export const NS = { hit: 1, miss: 100, prefetched: 8 } as const;

export type Workload = "matrix" | "records";
export type Order = "row" | "col";
export type Layout = "aos" | "soa";
export type Rows = 8 | 32;
export type Prediction = "same" | "double" | "all";
export type ChallengeId = "colPain" | "fits" | "soa" | "prefetch";

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "colPain", text: "Run row order and column order on 32 hosts, and compare." },
  { id: "fits", text: "Make column order cost no more misses than row order." },
  { id: "soa", text: "Cut the misses of the price sum by four without reading fewer prices." },
  { id: "prefetch", text: "Get a full row-order run down to a single miss." },
];

export const FIELDS = ["id", "price", "qty", "ts"] as const;

export interface Way { line: number; used: number; pre: boolean }
export interface Access {
  addr: number; cell: number; line: number; set: number; tag: number; offset: number;
  result: "hit" | "miss" | "prefetched";
  evicted: number | null; prefetched: number | null; manual: boolean;
}
export interface Stats { reads: number; hits: number; misses: number; prefHits: number; prefetches: number; ns: number }
export interface Run { id: number; label: string; workload: Workload; order: Order; layout: Layout; rows: Rows; prefetch: boolean; stats: Stats }

export interface State {
  workload: Workload;
  order: Order;
  layout: Layout;
  rows: Rows;
  prefetch: boolean;
  sets: Way[][];
  clock: number;
  pos: number;
  stats: Stats;
  /** Per 8-byte cell: 0 not read yet, 1 last read hit, 2 last read missed, 3 prefetched hit. */
  marks: number[];
  last: Access | null;
  manual: boolean;
  runs: Run[];
  nextRun: number;
  prediction: Prediction | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "workload"; value: Workload }
  | { type: "order"; value: Order }
  | { type: "layout"; value: Layout }
  | { type: "rows"; value: Rows }
  | { type: "prefetch"; value: boolean }
  | { type: "step"; n: number }
  | { type: "run" }
  | { type: "touch"; cell: number }
  | { type: "predict"; value: Prediction }
  | { type: "reset" };

/* ---------------------------------------------------------------- layout of memory */

export function bytes(st: Pick<State, "workload" | "rows">): number {
  return st.workload === "matrix" ? st.rows * COLS * ELEM : RECORDS * FIELDS.length * ELEM;
}
export const cells = (st: Pick<State, "workload" | "rows">) => bytes(st) / ELEM;

/** The addresses the loop reads, in order. */
export function trace(st: Pick<State, "workload" | "rows" | "order" | "layout">): number[] {
  const out: number[] = [];
  if (st.workload === "matrix") {
    if (st.order === "row") { for (let r = 0; r < st.rows; r++) for (let c = 0; c < COLS; c++) out.push((r * COLS + c) * ELEM); }
    else { for (let c = 0; c < COLS; c++) for (let r = 0; r < st.rows; r++) out.push((r * COLS + c) * ELEM); }
  } else if (st.layout === "aos") {
    for (let i = 0; i < RECORDS; i++) out.push(i * FIELDS.length * ELEM + 1 * ELEM);
  } else {
    for (let i = 0; i < RECORDS; i++) out.push(1 * RECORDS * ELEM + i * ELEM);
  }
  return out;
}

/** What lives in a cell, for labels: matrix (host, minute) or a record field. */
export function cellInfo(st: Pick<State, "workload" | "layout">, cell: number): { text: string; field?: string; row?: number; col?: number; used: boolean } {
  if (st.workload === "matrix") {
    const row = Math.floor(cell / COLS), col = cell % COLS;
    return { text: `host ${row}, minute ${col}`, row, col, used: true };
  }
  if (st.layout === "aos") {
    const rec = Math.floor(cell / FIELDS.length), field = FIELDS[cell % FIELDS.length];
    return { text: `order ${rec}.${field}`, field, used: field === "price" };
  }
  const field = FIELDS[Math.floor(cell / RECORDS)], rec = cell % RECORDS;
  return { text: `${field}[${rec}]`, field, used: field === "price" };
}

/** A short label for what a cached line holds. */
export function lineLabel(st: Pick<State, "workload" | "layout">, line: number): string {
  const first = line * PER_LINE;
  if (st.workload === "matrix") {
    const r = Math.floor(first / COLS), c = first % COLS;
    return `h${r} m${c}–${c + PER_LINE - 1}`;
  }
  if (st.layout === "aos") return `orders ${first / FIELDS.length}–${first / FIELDS.length + 1}`;
  const field = FIELDS[Math.floor(first / RECORDS)], i = first % RECORDS;
  return `${field} ${i}–${i + PER_LINE - 1}`;
}

export const split = (addr: number) => ({ line: Math.floor(addr / LINE), set: Math.floor(addr / LINE) % SETS, tag: Math.floor(addr / LINE / SETS), offset: addr % LINE });

/* ---------------------------------------------------------------- the cache */

const emptySets = (): Way[][] => Array.from({ length: SETS }, () => Array.from({ length: WAYS }, () => ({ line: -1, used: 0, pre: false })));
const zero = (): Stats => ({ reads: 0, hits: 0, misses: 0, prefHits: 0, prefetches: 0, ns: 0 });
const noneDone = (): Record<ChallengeId, boolean> => ({ colPain: false, fits: false, soa: false, prefetch: false });

/** Put a line into its set, evicting the least recently used way. Returns the evicted line. */
function fill(sets: Way[][], line: number, clock: number, pre: boolean): number | null {
  const ways = sets[line % SETS];
  let victim = ways.findIndex((w) => w.line < 0);
  if (victim < 0) victim = ways.reduce((best, w, i) => (w.used < ways[best].used ? i : best), 0);
  const evicted = ways[victim].line >= 0 ? ways[victim].line : null;
  ways[victim] = { line, used: clock, pre };
  return evicted;
}

export const cached = (sets: Way[][], line: number) => sets[line % SETS].some((w) => w.line === line);

/** One read through the cache. Pure: returns new sets and stats. */
export function access(st: State, addr: number, manual: boolean): State {
  const sets = st.sets.map((s) => s.map((w) => ({ ...w })));
  const clock = st.clock + 1;
  const sp = split(addr);
  const way = sets[sp.set].find((w) => w.line === sp.line);
  const stats = { ...st.stats, reads: st.stats.reads + 1 };
  let result: Access["result"];
  let evicted: number | null = null;
  let trigger = false;
  if (way) {
    way.used = clock;
    if (way.pre) { result = "prefetched"; way.pre = false; stats.prefHits++; stats.ns += NS.prefetched; trigger = true; }
    else { result = "hit"; stats.hits++; stats.ns += NS.hit; }
  } else {
    result = "miss"; stats.misses++; stats.ns += NS.miss; trigger = true;
    evicted = fill(sets, sp.line, clock, false);
  }
  let prefetched: number | null = null;
  const lines = bytes(st) / LINE;
  if (st.prefetch && trigger && sp.line + 1 < lines && !cached(sets, sp.line + 1)) {
    prefetched = sp.line + 1;
    // Line L+1 maps to the next set, so it never evicts the line just read.
    fill(sets, prefetched, clock, true);
    stats.prefetches++;
  }
  const marks = st.marks.slice();
  const cell = addr / ELEM;
  marks[cell] = result === "hit" ? 1 : result === "miss" ? 2 : 3;
  return { ...st, sets, clock: clock + 1, stats, marks, last: { addr, cell, ...sp, result, evicted, prefetched, manual }, manual: st.manual || manual };
}

/* ---------------------------------------------------------------- runs and the step function */

export function runLabel(st: Pick<State, "workload" | "rows" | "order" | "layout" | "prefetch">): string {
  const base = st.workload === "matrix"
    ? `${st.rows} hosts × ${COLS} minutes, ${st.order === "row" ? "row" : "column"} order`
    : `sum of price, ${st.layout === "aos" ? "array of structs" : "struct of arrays"}`;
  return base + (st.prefetch ? ", prefetcher on" : "");
}

function fresh(st: State, patch: Partial<State> = {}): State {
  const next = { ...st, ...patch };
  return { ...next, sets: emptySets(), clock: 0, pos: 0, stats: zero(), marks: Array(cells(next)).fill(0), last: null, manual: false };
}

export function init(): State {
  const base = {
    workload: "matrix", order: "row", layout: "aos", rows: 32, prefetch: false, runs: [], nextRun: 1, prediction: null, done: noneDone(),
  } as Omit<State, "sets" | "clock" | "pos" | "stats" | "marks" | "last" | "manual">;
  return fresh(base as State);
}

export const total = (st: State) => trace(st).length;
export const missRate = (s: Stats) => (s.reads ? s.misses / s.reads : 0);
export const ramBytes = (s: Stats) => (s.misses + s.prefetches) * LINE;

function finish(st: State): State {
  if (st.pos < total(st) || st.manual) return st;
  const run: Run = { id: st.nextRun, label: runLabel(st), workload: st.workload, order: st.order, layout: st.layout, rows: st.rows, prefetch: st.prefetch, stats: st.stats };
  const runs = [run, ...st.runs].slice(0, 8);
  const done = { ...st.done };
  const has = (f: (r: Run) => boolean) => runs.some(f);
  const plain = (r: Run) => r.workload === "matrix" && !r.prefetch;
  if (has((r) => plain(r) && r.rows === 32 && r.order === "row") && has((r) => plain(r) && r.rows === 32 && r.order === "col")) done.colPain = true;
  if (run.workload === "matrix" && run.order === "col" && run.stats.misses <= (run.rows * COLS) / PER_LINE) done.fits = true;
  if (run.workload === "records" && run.layout === "soa" && has((r) => r.workload === "records" && r.layout === "aos" && r.stats.misses >= 4 * run.stats.misses)) done.soa = true;
  if (run.workload === "matrix" && run.order === "row" && run.stats.misses <= 1) done.prefetch = true;
  return { ...st, runs, nextRun: st.nextRun + 1, done };
}

function advance(st: State, n: number): State {
  const t = trace(st);
  let s = st;
  if (s.pos >= t.length) s = fresh(s); // the loop already finished: start it again on a cold cache
  for (let i = 0; i < n && s.pos < t.length; i++) s = { ...access(s, t[s.pos], false), pos: s.pos + 1 };
  return finish(s);
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "workload": return fresh(st, { workload: a.value });
    case "order": return fresh(st, { order: a.value });
    case "layout": return fresh(st, { layout: a.value });
    case "rows": return fresh(st, { rows: a.value });
    case "prefetch": return fresh(st, { prefetch: a.value });
    case "step": return advance(st, a.n);
    case "run": return advance(st, Number.MAX_SAFE_INTEGER);
    case "touch": {
      if (a.cell < 0 || a.cell >= cells(st)) return st;
      return access(st, a.cell * ELEM, true);
    }
    case "predict": return { ...st, prediction: a.value };
    case "reset": return init();
  }
}

/** The finished runs to compare: the slowest and the fastest of the current workload. */
export function compare(st: State): { slow: Run; fast: Run } | null {
  const same = st.runs.filter((r) => r.workload === st.workload && (r.workload === "records" || r.rows === st.rows));
  if (same.length < 2) return null;
  const slow = same.reduce((a, b) => (b.stats.ns > a.stats.ns ? b : a));
  const fast = same.reduce((a, b) => (b.stats.ns < a.stats.ns ? b : a));
  return slow.stats.ns > fast.stats.ns ? { slow, fast } : null;
}
