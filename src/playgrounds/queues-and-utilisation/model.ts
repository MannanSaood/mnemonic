// Checkout queue: a queue in front of one or more identical workers.
//
// After this, the reader can answer: "Why does waiting time explode as a worker nears 100% busy,
// even though there is still spare capacity, and what does adding a worker do to it?"
// Core insight: with random arrivals, the mean wait grows like ρ / (1 − ρ). From 50% to 90%
// busy the wait grows ninefold, at 95% nineteenfold, and at 100% the queue never drains.
// Adding one worker at 95% busy cuts the wait by far more than half, because utilisation drops
// back to the flat part of the curve. Little's law (L = λW) ties the numbers together.
//
// The simulation is a seeded discrete-event model of a FIFO queue with c workers (M/M/c, or
// M/D/c with constant service times). It processes a fixed number of jobs and measures waits,
// utilisation, queue length over time and rejections (when the queue is bounded). The same
// random numbers are reused across settings, so moving a slider changes one thing at a time.

export const JOBS = 20_000;
/** Mean service time of one job in ms. A worker can do 1000 / SERVICE_MS jobs a second. */
export const SERVICE_MS = 10;
export const PER_WORKER = 1000 / SERVICE_MS;
export const SERVER_OPTIONS = [1, 2, 4] as const;
export const LIMIT = 50;
export const BURST = 40;
export const SERIES = 240;
export const MIN_RATE = 5, MAX_RATE = 200;

export type Variability = "random" | "constant";

export interface Config {
  /** Arrivals per second (Poisson). */
  rate: number;
  servers: number;
  variability: Variability;
  /** Bound the queue at LIMIT waiting jobs and reject the rest. */
  bounded: boolean;
  /** Add BURST jobs arriving at the same instant, 10% into the run. */
  burst: boolean;
}

export interface Result {
  config: Config;
  /** Offered load: arrival rate × service time / workers. */
  rho: number;
  /** Measured share of worker time spent busy over the run. */
  util: number;
  served: number;
  rejected: number;
  meanWait: number;
  p99Wait: number;
  maxWait: number;
  /** Time-average number of jobs in the system (waiting or in service), measured by sweeping events. */
  inSystem: number;
  /** λ × W: arrival rate times mean time in system. Little's law says this equals inSystem. */
  littleLW: number;
  maxQueue: number;
  /** Jobs still waiting when the last job arrived. */
  endQueue: number;
  /** Queue length (waiting, not in service) at SERIES evenly spaced times. */
  series: number[];
  durationS: number;
  /** Theory for the mean wait in ms, or null when the queue never drains (ρ ≥ 1). */
  theoryWait: number | null;
  /** Queue length the moment the run ended, for the snapshot. */
  snapshot: { busy: number; waiting: number };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unit exponentials for gaps and service times, shared by every run (common random numbers). */
const R = (() => {
  const r = mulberry32(2024);
  const gaps = new Float64Array(JOBS + BURST), work = new Float64Array(JOBS + BURST);
  for (let i = 0; i < JOBS + BURST; i++) { gaps[i] = -Math.log(1 - r()); work[i] = -Math.log(1 - r()); }
  return { gaps, work };
})();

function factorial(n: number) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }

/** Erlang C: the probability an arriving job has to wait, for c workers and a = λS. */
export function erlangC(c: number, a: number): number {
  if (a >= c) return 1;
  let sum = 0;
  for (let k = 0; k < c; k++) sum += a ** k / factorial(k);
  const top = (a ** c / factorial(c)) * (c / (c - a));
  return top / (sum + top);
}

/**
 * Mean wait in the queue, in ms. M/M/c via Erlang C; with constant service times the wait is
 * scaled by (1 + cs²) / 2 = 1/2, exact for one worker (Pollaczek-Khinchine) and a standard
 * approximation for more.
 */
export function theoryWait(rate: number, servers: number, variability: Variability): number | null {
  const S = SERVICE_MS / 1000, a = rate * S, rho = a / servers;
  if (rho >= 1) return null;
  const w = (erlangC(servers, a) * S) / (servers * (1 - rho));
  return (variability === "constant" ? w / 2 : w) * 1000;
}

export function simulate(c: Config): Result {
  const S = SERVICE_MS;
  const meanGap = 1000 / c.rate;
  // Arrival times in ms.
  const n = JOBS + (c.burst ? BURST : 0);
  const arrivals: number[] = [];
  let t = 0;
  for (let i = 0; i < JOBS; i++) { t += R.gaps[i] * meanGap; arrivals.push(t); }
  const span = t;
  if (c.burst) {
    const at = span * 0.1;
    let idx = arrivals.findIndex((x) => x > at);
    if (idx < 0) idx = arrivals.length;
    arrivals.splice(idx, 0, ...Array(BURST).fill(at));
  }
  const free = new Array(c.servers).fill(0);
  const starts: number[] = [];
  const queued: number[] = []; // start times of accepted jobs, for queue length at arrival
  let qHead = 0;
  const waits: number[] = [];
  const departs: number[] = [];
  let rejected = 0, busy = 0, maxQueue = 0, svcSum = 0;
  const arrivedAt: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = arrivals[i];
    while (qHead < queued.length && queued[qHead] <= at) qHead++;
    const waiting = queued.length - qHead;
    if (c.bounded && waiting >= LIMIT) { rejected++; continue; }
    let k = 0;
    for (let j = 1; j < c.servers; j++) if (free[j] < free[k]) k = j;
    const start = Math.max(at, free[k]);
    const service = c.variability === "constant" ? S : R.work[i] * S;
    free[k] = start + service;
    svcSum += service;
    if (start > at) queued.push(start);
    if (waiting + (start > at ? 1 : 0) > maxQueue) maxQueue = waiting + (start > at ? 1 : 0);
    waits.push(start - at);
    starts.push(start);
    arrivedAt.push(at);
    busy += Math.max(0, Math.min(start + service, span) - Math.min(start, span));
    departs.push(start + service);
  }
  // Time-average number in system over [0, span]: the area under N(t) is the sum, over jobs,
  // of the time each spent in the system inside the window.
  let area = 0;
  for (let i = 0; i < starts.length; i++) area += Math.max(0, Math.min(departs[i], span) - arrivedAt[i]);
  // Queue length (waiting) at evenly spaced times. Arrivals and FIFO start times are both sorted.
  const series: number[] = [];
  const qArr: number[] = [], qStart: number[] = [];
  for (let i = 0; i < starts.length; i++) if (starts[i] > arrivedAt[i]) { qArr.push(arrivedAt[i]); qStart.push(starts[i]); }
  let ai = 0, si = 0;
  for (let k = 1; k <= SERIES; k++) {
    const at = (span * k) / SERIES;
    while (ai < qArr.length && qArr[ai] <= at) ai++;
    while (si < qStart.length && qStart[si] <= at) si++;
    series.push(ai - si);
  }
  const served = waits.length;
  const sorted = Float64Array.from(waits).sort();
  const meanWait = waits.reduce((a, b) => a + b, 0) / served;
  const meanSys = meanWait + svcSum / served;
  const lambdaEff = served / (span / 1000);
  const endQueue = series[series.length - 1];
  let busyNow = 0;
  for (const f of free) if (f > span) busyNow++;
  return {
    config: { ...c },
    rho: (c.rate * S) / 1000 / c.servers,
    util: Math.min(1, busy / (c.servers * span)),
    served,
    rejected,
    meanWait,
    p99Wait: sorted[Math.min(served - 1, Math.ceil(0.99 * served) - 1)],
    maxWait: sorted[served - 1],
    inSystem: area / span,
    littleLW: lambdaEff * (meanSys / 1000),
    maxQueue,
    endQueue,
    series,
    durationS: span / 1000,
    theoryWait: theoryWait(c.rate, c.servers, c.variability),
    snapshot: { busy: busyNow, waiting: endQueue },
  };
}

/* ---------------- the reader's state ---------------- */

export const CHALLENGES = [
  { id: "cliff", text: "With one worker, find the arrival rate where jobs wait more than 10× the service time." },
  { id: "teller", text: "At 95 jobs a second, cut the mean wait by more than 10× without making any worker faster." },
  { id: "burst", text: "Make a queue of 30+ jobs form while the workers are less than 30% busy." },
  { id: "smooth", text: "At 90% busy on one worker, halve the wait without adding capacity." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export type Guess = "18" | "20" | "90" | "1000";

export interface State {
  config: Config;
  /** Recent runs, newest first. */
  runs: Result[];
  guess: Guess | null;
  done: ChallengeId[];
}

export type Action =
  | { type: "rate"; value: number }
  | { type: "servers"; value: number }
  | { type: "variability"; value: Variability }
  | { type: "bounded"; on: boolean }
  | { type: "burst"; on: boolean }
  | { type: "guess"; value: Guess }
  | { type: "reset" };

export function init(): State {
  const config: Config = { rate: 50, servers: 1, variability: "random", bounded: false, burst: false };
  return { config, runs: [simulate(config)], guess: null, done: [] };
}

const same = (a: Config, b: Config) => a.rate === b.rate && a.servers === b.servers && a.variability === b.variability && a.bounded === b.bounded && a.burst === b.burst;

function settle(s: State, config: Config): State {
  const r = simulate(config);
  const runs = [r, ...s.runs.filter((x) => !same(x.config, config))].slice(0, 12);
  const done = new Set(s.done);
  const S = SERVICE_MS;
  const plain = (x: Result) => !x.config.bounded && !x.config.burst;
  if (r.config.servers === 1 && plain(r) && r.config.variability === "random" && r.meanWait > 10 * S) done.add("cliff");
  const at95 = runs.filter((x) => x.config.rate === 95 && plain(x) && x.config.variability === "random");
  const one = at95.find((x) => x.config.servers === 1);
  if (one && at95.some((x) => x.config.servers > 1 && x.meanWait * 10 < one.meanWait)) done.add("teller");
  if (r.config.burst && r.maxQueue >= 30 && r.util < 0.3) done.add("burst");
  const at90 = runs.filter((x) => x.config.servers === 1 && plain(x) && x.config.rate === 90);
  const rnd = at90.find((x) => x.config.variability === "random"), cst = at90.find((x) => x.config.variability === "constant");
  if (rnd && cst && cst.meanWait * 2 <= rnd.meanWait * 1.05) done.add("smooth");
  return { ...s, config, runs, done: CHALLENGES.map((c) => c.id).filter((id) => done.has(id)) };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.guess ? s : { ...s, guess: a.value };
    case "rate": return settle(s, { ...s.config, rate: Math.max(MIN_RATE, Math.min(MAX_RATE, Math.round(a.value))) });
    case "servers": return settle(s, { ...s.config, servers: a.value });
    case "variability": return settle(s, { ...s.config, variability: a.value });
    case "bounded": return settle(s, { ...s.config, bounded: a.on });
    case "burst": return settle(s, { ...s.config, burst: a.on });
  }
}

export const current = (s: State) => s.runs[0];

/** The prediction is revealed once the reader has run one random-service worker at 90%+ busy. */
export const revealed = (s: State) =>
  s.runs.some((r) => r.config.servers === 1 && r.config.variability === "random" && !r.config.bounded && !r.config.burst && r.rho >= 0.9);

export const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
