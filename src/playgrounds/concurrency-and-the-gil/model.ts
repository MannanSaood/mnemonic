// Concurrency-and-the-GIL playground: the same batch of jobs on a 4-core machine, run with
// threads, processes or asyncio, with a health-check probe arriving every 100 ms.
//
// Purpose. After this, the reader can answer: "Which of threads, processes and asyncio makes
// this workload faster, and why?" On the standard CPython build only the thread holding the
// GIL runs Python bytecode, so threads overlap waiting (I/O) but not computing (CPU). Processes
// each have their own interpreter and GIL, so they use every core, at a start-up and pickling
// cost. asyncio runs everything on one thread and only switches at await, so CPU work blocks
// every other task, the probe included.
//
// The simulation runs in 1 ms ticks. Every model is the same machine with a different number
// of "tokens" that let a worker execute Python:
//   threads, standard build  1 token (the GIL), handed over after the 5 ms switch interval
//   threads, free-threaded   one token per core; CPU work runs 10% slower (single-thread overhead)
//   processes                one token per core; each process starts in 60 ms; 2 ms to pickle a job
//   asyncio                  1 token (the loop), never taken away: a task keeps it until it awaits
// The start-up, pickling and overhead numbers are round assumptions, stated in the view.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const CORES = 4;
export const JOBS = 24;
export const SWITCH_MS = 5;
export const PROBE_EVERY = 100;
export const PROBE_FIRST = 50;
export const PROC_START_MS = 60;
export const PICKLE_MS = 2;
export const FT_OVERHEAD = 1.1;

export type Workload = "io" | "cpu" | "mixed";
export type Model = "threads" | "processes" | "asyncio";
export type Build = "gil" | "free";
export const WORKLOADS: Workload[] = ["io", "cpu", "mixed"];
export const MODELS: Model[] = ["threads", "processes", "asyncio"];
export const WORKER_COUNTS = [1, 2, 4, 8, 16];

export interface Seg { kind: "cpu" | "io"; ms: number }
export const JOB: Record<Workload, Seg[]> = {
  // deliver one webhook: build the request, wait for the endpoint, read the reply
  io: [{ kind: "cpu", ms: 2 }, { kind: "io", ms: 120 }, { kind: "cpu", ms: 2 }],
  // validate one payload against a JSON schema, in pure Python
  cpu: [{ kind: "cpu", ms: 40 }],
  // the change request: validate, then deliver
  mixed: [{ kind: "cpu", ms: 40 }, { kind: "io", ms: 120 }, { kind: "cpu", ms: 2 }],
};
export const WORKLOAD_LABEL: Record<Workload, string> = { io: "Webhooks (I/O)", cpu: "Schema validation (CPU)", mixed: "Validate, then deliver" };

export interface Config { workload: Workload; model: Model; build: Build; workers: number }

export type Cell = "run" | "wait" | "io" | "idle" | "start";

export interface Result {
  config: Config;
  makespan: number;
  throughput: number;
  coreUse: number;
  waitMs: number;
  probeWorst: number;
  probes: number;
  /** One lane per worker, then the probe lane. Run-length encoded. */
  lanes: { label: string; spans: { from: number; to: number; cell: Cell }[] }[];
  /** Workers executing Python, per tick (only the busy count). */
  busy: number[];
}

interface Params { tokens: number; preempt: boolean; speed: number; startup: number; extraCpu: number }
export function params(c: Config): Params {
  if (c.model === "asyncio") return { tokens: 1, preempt: false, speed: 1, startup: 0, extraCpu: 0 };
  if (c.model === "processes") return { tokens: CORES, preempt: true, speed: 1, startup: PROC_START_MS, extraCpu: PICKLE_MS };
  return c.build === "free" ? { tokens: CORES, preempt: true, speed: 1 / FT_OVERHEAD, startup: 0, extraCpu: 0 } : { tokens: 1, preempt: true, speed: 1, startup: 0, extraCpu: 0 };
}

interface Ent { segs: Seg[] | null; seg: number; left: number; holding: boolean; holdSince: number; waitSince: number | null; startup: number; cells: Cell[] }

/** Run the batch. Pure and deterministic. */
export function simulate(c: Config): Result {
  const p = params(c);
  const k = c.workers;
  const jobSegs = (): Seg[] => {
    const segs = JOB[c.workload].map((s) => ({ ...s }));
    if (p.extraCpu) segs.unshift({ kind: "cpu", ms: p.extraCpu });
    return segs;
  };
  const ents: Ent[] = Array.from({ length: k + 1 }, (_, i) => ({ segs: null, seg: 0, left: 0, holding: false, holdSince: 0, waitSince: null, startup: i < k ? p.startup : 0, cells: [] }));
  const probe = ents[k];
  let nextJob = 0, done = 0, makespan = 0, waitMs = 0, cpuTicks = 0;
  const probeLat: number[] = [];
  let probeArrived = -1;
  const busy: number[] = [];
  const wantsCpu = (e: Ent) => e.segs !== null && e.segs[e.seg].kind === "cpu";

  for (let t = 0; t < 20000 && done < JOBS; t++) {
    // 1. idle workers take the next job; the probe arrives on its schedule
    for (let i = 0; i < k; i++) {
      const e = ents[i];
      if (e.startup > 0 || e.segs || nextJob >= JOBS) continue;
      e.segs = jobSegs(); e.seg = 0; e.left = e.segs[0].ms; nextJob++;
    }
    if (t >= PROBE_FIRST && (t - PROBE_FIRST) % PROBE_EVERY === 0 && !probe.segs) {
      probe.segs = [{ kind: "cpu", ms: 1 }]; probe.seg = 0; probe.left = 1; probeArrived = t;
    }
    // 2. who wants to execute Python and does not hold a token yet
    for (const e of ents) if (wantsCpu(e) && !e.holding && e.waitSince === null) e.waitSince = t;
    const waiters = () => ents.filter((e) => e.waitSince !== null && !e.holding).sort((a, b) => a.waitSince! - b.waitSince!);
    let free = p.tokens - ents.filter((e) => e.holding).length;
    // 3. forced switch: a waiter that has waited a whole switch interval makes the longest holder drop
    if (p.preempt && free === 0) {
      const w = waiters()[0];
      if (w && t - w.waitSince! >= SWITCH_MS) {
        const h = ents.filter((e) => e.holding).sort((a, b) => a.holdSince - b.holdSince)[0];
        h.holding = false; h.waitSince = t;
        free++;
      }
    }
    // 4. free tokens go to waiters in arrival order
    for (const w of waiters()) {
      if (free <= 0) break;
      w.holding = true; w.holdSince = t; w.waitSince = null; free--;
    }
    // 5. advance one tick
    let running = 0;
    for (const e of ents) {
      if (e.startup > 0) { e.cells.push("start"); e.startup--; continue; }
      if (!e.segs) { e.cells.push("idle"); continue; }
      const s = e.segs[e.seg];
      if (s.kind === "io") { e.cells.push("io"); e.left -= 1; }
      else if (e.holding) { e.cells.push("run"); e.left -= p.speed; running++; cpuTicks++; }
      else { e.cells.push("wait"); if (e !== probe) waitMs++; }
      if (e.left <= 1e-9) {
        e.seg++;
        const next = e.segs[e.seg];
        if (!next || next.kind === "io") { e.holding = false; }
        if (!next) {
          e.segs = null;
          if (e === probe) probeLat.push(t + 1 - probeArrived);
          else { done++; if (done === JOBS) makespan = t + 1; }
        } else e.left = next.ms;
      }
    }
    busy.push(running);
  }

  const lanes = ents.map((e, i) => {
    const spans: { from: number; to: number; cell: Cell }[] = [];
    e.cells.slice(0, makespan).forEach((cell, t) => {
      const last = spans[spans.length - 1];
      if (last && last.cell === cell && last.to === t) last.to = t + 1;
      else spans.push({ from: t, to: t + 1, cell });
    });
    return { label: i < k ? `${c.model === "processes" ? "proc" : c.model === "asyncio" ? "task" : "thread"} ${i + 1}` : "probe", spans };
  });
  return {
    config: { ...c },
    makespan,
    throughput: Math.round((JOBS / makespan) * 1000),
    coreUse: Math.round((cpuTicks / (CORES * makespan)) * 100),
    waitMs,
    probeWorst: probeLat.length ? Math.max(...probeLat) : 0,
    probes: probeLat.length,
    lanes,
    busy: busy.slice(0, makespan),
  };
}

/* ---------------- challenges ---------------- */

export interface Summary { key: string; config: Config; makespan: number; throughput: number; coreUse: number; waitMs: number; probeWorst: number }
export const keyOf = (c: Config) => `${c.workload}|${c.model}|${c.model === "threads" ? c.build : "-"}|${c.workers}`;
const summarise = (r: Result): Summary => ({ key: keyOf(r.config), config: r.config, makespan: r.makespan, throughput: r.throughput, coreUse: r.coreUse, waitMs: r.waitMs, probeWorst: r.probeWorst });

export const BASE_CPU = () => simulate({ workload: "cpu", model: "threads", build: "gil", workers: 1 }).makespan;
export const MIXED_TARGET_MS = 700;

export interface Challenge { id: string; text: string; met: (runs: Summary[]) => boolean }
export const CHALLENGES: Challenge[] = [
  { id: "speed", text: "Run the CPU batch at least 3× faster than one thread does.", met: (rs) => rs.some((r) => r.config.workload === "cpu" && r.makespan * 3 <= BASE_CPU()) },
  { id: "probe", text: "Find a setup where the health probe waits more than 30 ms.", met: (rs) => rs.some((r) => r.probeWorst > 30) },
  { id: "mixed", text: `Finish the validate-then-deliver batch in under ${MIXED_TARGET_MS} ms on the standard build.`, met: (rs) => rs.some((r) => r.config.workload === "mixed" && r.makespan < MIXED_TARGET_MS && !(r.config.model === "threads" && r.config.build === "free")) },
];

/* ---------------- state ---------------- */

export type Guess = "8x" | "4x" | "same";

export interface State {
  config: Config;
  guess: Guess | null;
  /** Every configuration the reader has run, latest last. */
  runs: Summary[];
}

export type Action =
  | { type: "workload"; workload: Workload }
  | { type: "model"; model: Model }
  | { type: "build"; build: Build }
  | { type: "workers"; workers: number }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

export const START: Config = { workload: "cpu", model: "threads", build: "gil", workers: 1 };

export function init(): State {
  return { config: { ...START }, guess: null, runs: [summarise(simulate(START))] };
}

function apply(st: State, config: Config): State {
  const s = summarise(simulate(config));
  return { ...st, config, runs: [...st.runs.filter((r) => r.key !== s.key), s] };
}

/** The prediction is answered once the reader has run CPU work on more than one standard-build thread. */
export const revealed = (st: State) => st.runs.some((r) => r.config.workload === "cpu" && r.config.model === "threads" && r.config.build === "gil" && r.config.workers > 1);

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "workload":
      return apply(st, { ...st.config, workload: a.workload });
    case "model":
      return apply(st, { ...st.config, model: a.model });
    case "build":
      return apply(st, { ...st.config, build: a.build });
    case "workers":
      return apply(st, { ...st.config, workers: a.workers });
    case "guess":
      return st.guess ? st : { ...st, guess: a.guess };
  }
}
