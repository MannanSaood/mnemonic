// Fold the stacks: a sampling profiler over a simulated order export.
//
// After this, the reader can answer: "How does a sampling profiler turn stack samples into a
// flame graph, what does a frame's width mean, and what does an on-CPU flame graph leave out?"
// Core insight: a timer interrupts the program at a fixed rate and records the call stack;
// identical stacks are counted (folded); the flame graph draws each frame as wide as the share
// of samples it appears in. Width is a share of samples, the x-axis is alphabetical, not time.
// An on-CPU profile only samples while the thread runs, so time spent waiting (fsync, network,
// locks) is invisible in it, however much of the request it takes. And a sample rate in
// lockstep with periodic work (100 Hz against a 10 ms timer) misleads; 99 Hz does not.
//
// The program is one thread exporting ORDERS orders: a database query, then per order a
// currency lookup that re-parses a JSON table, row formatting, and an audit record written and
// fsynced to disk, then JSON encoding. A metrics timer runs for 0.5 ms every 10 ms. All times
// are deterministic; the reader can "make a frame free" to see what fixing it would save.

export const ORDERS = 2000;
export const FLUSH_EVERY = 10;
export const FLUSH_MS = 0.5;
/** The sampler's first tick, in ms. Chosen so that 100 Hz lands inside every flush. */
export const PHASE = 0.25;
export const RATES = [19, 99, 100, 997] as const;
export type Mode = "cpu" | "wall";

const ROOT = ["main", "http.serve", "export.Handler"];
export const OFF_NET = "[off-CPU] network wait";
export const OFF_DISK = "[off-CPU] disk wait";
/** Frames that hold the whole request: making them free is not a fix. */
export const PROTECTED = new Set(["main", "http.serve", "export.Handler"]);

export interface Seg { stack: string[]; ms: number; on: boolean }

const PREFIX: Seg[] = [
  { stack: [...ROOT, "db.Query", OFF_NET], ms: 40, on: false },
  { stack: [...ROOT, "db.Query", "rows.Scan"], ms: 4, on: true },
];
const PER_ORDER: Seg[] = [
  { stack: [...ROOT, "formatRow", "currencySymbol", "json.decode"], ms: 0.4, on: true },
  { stack: [...ROOT, "formatRow"], ms: 0.04, on: true },
  { stack: [...ROOT, "audit.Record", "file.Write"], ms: 0.02, on: true },
  { stack: [...ROOT, "audit.Record", "file.Sync", OFF_DISK], ms: 1.0, on: false },
];
const SUFFIX: Seg[] = [{ stack: [...ROOT, "json.encode"], ms: 20, on: true }];
const FLUSH: Seg = { stack: ["main", "metrics.flush"], ms: FLUSH_MS, on: true };

/** The program with some frames made free (their segments removed). */
export interface Program {
  prefix: Seg[];
  perOrder: Seg[];
  suffix: Seg[];
  flush: boolean;
  /** Main-thread work excluding the timer, ms. */
  mainMs: number;
  /** Wall-clock time of the export, ms, including the timer's interruptions. */
  wallMs: number;
  cpuMs: number;
}

export function program(fixes: string[]): Program {
  const keep = (s: Seg) => !s.stack.some((f) => fixes.includes(f));
  const prefix = PREFIX.filter(keep), perOrder = PER_ORDER.filter(keep), suffix = SUFFIX.filter(keep);
  const flush = keep(FLUSH);
  const sum = (xs: Seg[]) => xs.reduce((a, s) => a + s.ms, 0);
  const mainMs = sum(prefix) + ORDERS * sum(perOrder) + sum(suffix);
  const slot = FLUSH_EVERY - FLUSH_MS;
  const wallMs = !flush ? mainMs : Math.floor(mainMs / slot) * FLUSH_EVERY + (mainMs % slot > 1e-9 ? FLUSH_MS + (mainMs % slot) : 0);
  const onMain = PREFIX.concat(SUFFIX).filter(keep).filter((s) => s.on).reduce((a, s) => a + s.ms, 0) + ORDERS * perOrder.filter((s) => s.on).reduce((a, s) => a + s.ms, 0);
  const cpuMs = onMain + (flush ? wallMs - mainMs : 0);
  return { prefix, perOrder, suffix, flush, mainMs, wallMs, cpuMs };
}

/** What the thread is doing at wall time t (ms). */
export function at(p: Program, t: number): Seg | null {
  let m = t;
  if (p.flush) {
    const w = t % FLUSH_EVERY;
    if (w < FLUSH_MS) return FLUSH;
    m = Math.floor(t / FLUSH_EVERY) * (FLUSH_EVERY - FLUSH_MS) + (w - FLUSH_MS);
  }
  if (m >= p.mainMs) return null;
  for (const s of p.prefix) { if (m < s.ms) return s; m -= s.ms; }
  const per = p.perOrder.reduce((a, s) => a + s.ms, 0);
  if (per > 0 && m < ORDERS * per) {
    let o = m % per;
    for (const s of p.perOrder) { if (o < s.ms) return s; o -= s.ms; }
    return p.perOrder[p.perOrder.length - 1];
  }
  m -= ORDERS * per;
  for (const s of p.suffix) { if (m < s.ms) return s; m -= s.ms; }
  return null;
}

export interface Sample { t: number; stack: string[] | null; on: boolean }

/** Every timer tick the profiler takes over the export. In CPU mode, ticks that find the thread off-CPU record nothing. */
export function ticks(p: Program, rate: number, mode: Mode): Sample[] {
  const period = 1000 / rate;
  const out: Sample[] = [];
  for (let t = PHASE; t < p.wallMs; t += period) {
    const s = at(p, t);
    if (!s) break;
    out.push({ t, stack: mode === "cpu" && !s.on ? null : s.stack, on: s.on });
  }
  return out;
}

/** Fold: count identical stacks. Keys are semicolon-joined, root first, as flamegraph.pl reads them. */
export function fold(samples: Sample[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of samples) if (s.stack) { const k = s.stack.join(";"); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

export interface Frame {
  name: string;
  /** Path from the root, semicolon-joined: identifies this box. */
  path: string;
  depth: number;
  /** Samples that include this frame. */
  total: number;
  /** Samples where this frame was on top (the leaf). */
  self: number;
  /** Offset from the left, in samples. */
  x: number;
  off: boolean;
  children: Frame[];
}

/** Build the flame graph: merge stacks into a tree; siblings sorted alphabetically (not by time). */
export function flame(folded: Map<string, number>): { root: Frame; frames: Frame[]; total: number } {
  const root: Frame = { name: "all", path: "", depth: -1, total: 0, self: 0, x: 0, off: false, children: [] };
  for (const [k, n] of folded) {
    root.total += n;
    let node = root;
    const parts = k.split(";");
    parts.forEach((name, i) => {
      let c = node.children.find((x) => x.name === name);
      if (!c) {
        c = { name, path: parts.slice(0, i + 1).join(";"), depth: i, total: 0, self: 0, x: 0, off: name.startsWith("[off-CPU]"), children: [] };
        node.children.push(c);
      }
      c.total += n;
      if (i === parts.length - 1) c.self += n;
      node = c;
    });
  }
  const frames: Frame[] = [];
  const place = (f: Frame, x: number) => {
    f.x = x;
    if (f !== root) frames.push(f);
    f.children.sort((a, b) => a.name.localeCompare(b.name));
    let cx = x;
    for (const c of f.children) { place(c, cx); cx += c.total; }
  };
  place(root, 0);
  return { root, frames, total: root.total };
}

/** The true share of time in a frame (by path prefix), for the chosen mode: CPU time or wall time. */
export function trueShare(p: Program, path: string, mode: Mode): number {
  const segs: { s: Seg; ms: number }[] = [
    ...p.prefix.map((s) => ({ s, ms: s.ms })),
    ...p.perOrder.map((s) => ({ s, ms: s.ms * ORDERS })),
    ...p.suffix.map((s) => ({ s, ms: s.ms })),
  ];
  if (p.flush) segs.push({ s: FLUSH, ms: p.wallMs - p.mainMs });
  const counted = segs.filter((x) => mode === "wall" || x.s.on);
  const denom = counted.reduce((a, x) => a + x.ms, 0);
  const num = counted.filter((x) => x.s.stack.join(";") === path || x.s.stack.join(";").startsWith(path + ";")).reduce((a, x) => a + x.ms, 0);
  return denom ? num / denom : 0;
}

/* ---------------- the reader's state ---------------- */

export const CHALLENGES = [
  { id: "hot", text: "Take every sample at 99 Hz on-CPU, then click a frame above export.Handler that is in more than half of the samples." },
  { id: "lockstep", text: "Make the flame graph lie: get metrics.flush, a 5% timer, into more than half of the samples." },
  { id: "hidden", text: "Find the wait that the on-CPU flame graph cannot show, and click it." },
  { id: "fast", text: "Get the export under 500 ms by making two frames free." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export type Guess = "70" | "25" | "0";

export interface State {
  rate: number;
  mode: Mode;
  /** Timer ticks taken so far; Infinity means all of them. */
  taken: number;
  fixes: string[];
  selected: string | null;
  guess: Guess | null;
  /** Wall times seen, newest first, with the fixes that produced them. */
  history: { fixes: string[]; wallMs: number; cpuMs: number }[];
  done: ChallengeId[];
}

export type Action =
  | { type: "rate"; value: number }
  | { type: "mode"; value: Mode }
  | { type: "take"; n: number }
  | { type: "takeAll" }
  | { type: "select"; path: string | null }
  | { type: "fix"; name: string }
  | { type: "unfix" }
  | { type: "guess"; value: Guess }
  | { type: "reset" };

export function init(): State {
  const p = program([]);
  return { rate: 99, mode: "cpu", taken: 0, fixes: [], selected: null, guess: null, history: [{ fixes: [], wallMs: p.wallMs, cpuMs: p.cpuMs }], done: [] };
}

export interface View {
  prog: Program;
  all: Sample[];
  taken: Sample[];
  folded: Map<string, number>;
  graph: ReturnType<typeof flame>;
}

export function view(s: State): View {
  const prog = program(s.fixes);
  const all = ticks(prog, s.rate, s.mode);
  const taken = all.slice(0, Math.min(all.length, s.taken));
  const folded = fold(taken);
  return { prog, all, taken, folded, graph: flame(folded) };
}

export const frameAt = (v: View, path: string | null) => (path ? v.graph.frames.find((f) => f.path === path) ?? null : null);

function settle(s: State): State {
  const v = view(s);
  const done = new Set(s.done);
  const allTaken = s.taken >= v.all.length;
  const sel = frameAt(v, s.selected);
  const total = v.graph.total;
  if (allTaken && s.mode === "cpu" && s.rate === 99 && sel && sel.depth >= 3 && total > 0 && sel.total / total > 0.5) done.add("hot");
  const flush = v.graph.frames.find((f) => f.path === "main;metrics.flush");
  if (allTaken && total > 0 && flush && flush.total / total > 0.5) done.add("lockstep");
  if (s.mode === "wall" && sel && (sel.name === OFF_DISK || sel.name === "file.Sync")) done.add("hidden");
  if (v.prog.wallMs < 500) done.add("fast");
  return { ...s, done: CHALLENGES.map((c) => c.id).filter((id) => done.has(id)) };
}

/** Keep "all samples taken" when the sample set changes; otherwise keep the count. */
function retake(prev: State, next: State): State {
  const before = view(prev).all.length;
  return { ...next, taken: prev.taken >= before ? Infinity : prev.taken };
}

function withHistory(s: State): State {
  const p = program(s.fixes);
  const key = [...s.fixes].sort().join(",");
  const history = [{ fixes: [...s.fixes], wallMs: p.wallMs, cpuMs: p.cpuMs }, ...s.history.filter((h) => [...h.fixes].sort().join(",") !== key)].slice(0, 8);
  return { ...s, history };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.guess ? s : { ...s, guess: a.value };
    case "rate": return settle(retake(s, { ...s, rate: a.value }));
    case "mode": return settle(retake(s, { ...s, mode: a.value, selected: null }));
    case "take": return settle({ ...s, taken: Math.min(view(s).all.length, (Number.isFinite(s.taken) ? s.taken : view(s).all.length) + a.n) });
    case "takeAll": return settle({ ...s, taken: Infinity });
    case "select": return settle({ ...s, selected: a.path });
    case "fix": {
      if (PROTECTED.has(a.name) || s.fixes.includes(a.name)) return s;
      return settle(withHistory(retake(s, { ...s, fixes: [...s.fixes, a.name], selected: null })));
    }
    case "unfix": return settle(withHistory(retake(s, { ...s, fixes: [], selected: null })));
  }
}

/** The prediction is revealed once the reader has made the currency lookup free. */
export const revealed = (s: State) => s.history.some((h) => h.fixes.some((f) => f === "currencySymbol" || f === "json.decode"));

export const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
export const pct = (x: number) => x >= 0.1 || x === 0 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`;
