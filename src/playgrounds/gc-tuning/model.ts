// Tuning the GC: a Go service's memory over six seconds, with a burst of live data in the middle,
// inside a 512 MiB container. The reader sets GOGC and GOMEMLIMIT and watches the heap sawtooth,
// how often the GC runs, how much CPU it takes, and whether the pod is OOM-killed.
//
// Purpose. After this, the reader can answer: "What do GOGC and GOMEMLIMIT trade, and where does
// each one fail?" GOGC sets the heap target as a multiple of the live heap: more memory, fewer
// cycles. GOMEMLIMIT caps the target, so the GC works harder instead of letting the container
// kill the pod. When the live heap itself nears the limit, the GC runs almost back to back
// (the death spiral) until the CPU limiter caps it at 50%, and the program runs at half speed.
//
// Scaled, deterministic model (one step = 10 ms, 600 steps):
// - GOMAXPROCS 4: 40 CPU-ms per step. At full speed the service allocates ALLOC_MIB per step.
// - Live heap: BASE MiB, ramping to the chosen peak between 1.5 s and 2.5 s, back by 5 s.
// - Heap target = live heap at the last cycle × (1 + GOGC/100), at least 4 MiB (GC guide; roots
//   ignored). With GOMEMLIMIT, the target is also capped at limit − OVERHEAD (stacks, runtime
//   and other non-heap memory the limit counts).
// - A cycle costs FIXED + PER_MIB × live heap CPU-ms. The pacer starts it early enough that,
//   with background workers at 25% of CPU, it ends near the target. If the heap reaches the
//   target first, allocating goroutines assist and the GC takes more CPU. When the cycle ends,
//   the garbage that existed at its start is freed; objects allocated during it survive.
// - CPU limiter: the GC may use at most 50% of CPU over a window (real: 2 × GOMAXPROCS
//   CPU-seconds; 1 s here). While it would exceed that, cycles wait and the heap overshoots.
// - The program gets the CPU the GC does not use, so it allocates (and serves) less.
// - Heap + OVERHEAD above the container limit: the kernel's OOM killer ends the run.
//
// Plain state + pure functions, so it can be tested without a browser.

export const STEP_MS = 10;
export const STEPS = 600;
export const CORES = 4;
export const CPU_PER_STEP = CORES * STEP_MS;
export const ALLOC_MIB = 4;
export const BASE = 100;
export const OVERHEAD = 40;
export const CONTAINER = 512;
export const FIXED = 2;
export const PER_MIB = 0.5;
export const WINDOW = 100;
export const CPU_CAP = 0.5;
export const MIN_HEAP = 4;

export const PEAKS = [100, 300, 380, 440] as const;
export const LIMITS = [null, 300, 400, 460, 600] as const;

export interface Params { gogc: number | null; limit: number | null; peak: number }
export interface Sample { t: number; heap: number; live: number; goal: number; total: number; gcShare: number; limiter: boolean }
export interface Sim {
  samples: Sample[]; cycles: number[]; oomAt: number | null;
  peakTotal: number; maxGcShare: number; avgGcShare: number; throughput: number; limiterMs: number;
}

/** Live heap at step i. */
export function liveAt(i: number, peak: number): number {
  const t = i * STEP_MS;
  const up = (a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  if (t < 1500) return BASE;
  if (t < 4500) return BASE + (peak - BASE) * up(1500, 2500);
  return peak - (peak - BASE) * up(4500, 5000);
}

export const cycleCost = (live: number) => FIXED + PER_MIB * live;

export function goalFor(p: Params, markedLive: number): number {
  const byGogc = p.gogc === null ? Infinity : Math.max(MIN_HEAP, markedLive * (1 + p.gogc / 100));
  const byLimit = p.limit === null ? Infinity : p.limit - OVERHEAD;
  return Math.min(byGogc, byLimit);
}

/** Heap size at which the pacer starts a cycle, so that it ends near the goal. */
export function triggerFor(goal: number, live: number): number {
  const steps = cycleCost(live) / (0.25 * CPU_PER_STEP);
  return Math.max(live, goal - steps * ALLOC_MIB * 0.75);
}

export function simulate(p: Params): Sim {
  const samples: Sample[] = [];
  const cycles: number[] = [];
  const gcHist: number[] = [];
  let heap = BASE, marked = BASE, oomAt: number | null = null;
  let debt = 0, garbageAtStart = 0;
  let peakTotal = 0, maxShare = 0, gcTotal = 0, work = 0, limiterSteps = 0;
  const windowShare = () => {
    const from = Math.max(0, gcHist.length - WINDOW);
    let sum = 0;
    for (let k = from; k < gcHist.length; k++) sum += gcHist[k];
    return sum / (WINDOW * CPU_PER_STEP);
  };
  for (let i = 0; i < STEPS; i++) {
    const live = liveAt(i, p.peak);
    const capped = windowShare() >= CPU_CAP;
    const goal = goalFor(p, marked);
    let limiter = false;

    // 1. Start a cycle when the heap reaches the trigger, unless one is running or the
    //    CPU limiter is holding the GC back.
    if (debt === 0 && heap >= triggerFor(goal, live)) {
      if (capped) limiter = true;
      else { debt = cycleCost(live); garbageAtStart = Math.max(0, heap - live); marked = live; cycles.push(i * STEP_MS); }
    } else if (debt > 0 && capped && heap >= goal) limiter = true;

    // 2. GC work: background workers take 25% of CPU. Past the goal, allocating goroutines
    //    assist and the GC takes up to all of it, unless the limiter caps it.
    const room = debt > 0 && heap >= goal && !capped ? CPU_PER_STEP : 0.25 * CPU_PER_STEP;
    const gcCpu = Math.min(debt, room);
    debt -= gcCpu;
    gcHist.push(gcCpu);
    gcTotal += gcCpu;

    // 3. The program runs with the CPU that is left, and allocates in proportion.
    //    Objects allocated during the cycle survive it; the garbage found at the start goes.
    const appShare = 1 - gcCpu / CPU_PER_STEP;
    work += appShare;
    heap = Math.max(heap + ALLOC_MIB * appShare, live);
    if (gcCpu > 0 && debt <= 1e-9) { debt = 0; heap = Math.max(live, heap - garbageAtStart); }

    if (limiter) limiterSteps++;
    const share = gcHist.slice(-10).reduce((a, b) => a + b, 0) / (Math.min(10, gcHist.length) * CPU_PER_STEP);
    if (gcHist.length >= 100) maxShare = Math.max(maxShare, gcHist.slice(-100).reduce((a, b) => a + b, 0) / (100 * CPU_PER_STEP));
    const total = heap + OVERHEAD;
    peakTotal = Math.max(peakTotal, total);
    samples.push({ t: i * STEP_MS, heap, live, goal: goalFor(p, marked), total, gcShare: share, limiter });
    if (total > CONTAINER) { oomAt = i * STEP_MS; break; }
  }
  const steps = samples.length;
  return {
    samples, cycles, oomAt, peakTotal,
    maxGcShare: maxShare,
    avgGcShare: gcTotal / (steps * CPU_PER_STEP),
    throughput: work / steps,
    limiterMs: limiterSteps * STEP_MS,
  };
}

/* ---------------- the playground's state ---------------- */

export type Guess = "fits" | "oom" | "slow";

export interface RunRow extends Params {
  cycles: number; oomAt: number | null; peakTotal: number; maxGcShare: number; throughput: number; limiterMs: number;
}

export interface State extends Params {
  shown: boolean;
  guess: Guess | null;
  runs: RunRow[];
}

export type Action =
  | { type: "gogc"; value: number | null }
  | { type: "limit"; value: number | null }
  | { type: "peak"; value: number }
  | { type: "run" }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

export const DEFAULTS: Params = { gogc: 100, limit: null, peak: 300 };

export function init(): State {
  return { ...DEFAULTS, shown: false, guess: null, runs: [] };
}

export const params = (s: Params): Params => ({ gogc: s.gogc, limit: s.limit, peak: s.peak });
const same = (a: Params, b: Params) => a.gogc === b.gogc && a.limit === b.limit && a.peak === b.peak;

export function summarize(p: Params): RunRow {
  const r = simulate(p);
  return { ...p, cycles: r.cycles.length, oomAt: r.oomAt, peakTotal: r.peakTotal, maxGcShare: r.maxGcShare, throughput: r.throughput, limiterMs: r.limiterMs };
}

function record(s: State): State {
  if (!s.shown) return s;
  const p = params(s);
  const runs = [...s.runs.filter((r) => !same(r, p)), summarize(p)].slice(-6);
  return { ...s, runs };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "gogc": return record({ ...s, gogc: a.value === null ? null : Math.max(25, Math.min(400, Math.round(a.value / 25) * 25)) });
    case "limit": return record({ ...s, limit: a.value });
    case "peak": return record({ ...s, peak: a.value });
    case "run": return s.shown ? s : record({ ...s, shown: true });
    case "guess": return s.shown ? s : { ...s, guess: a.guess };
  }
}
