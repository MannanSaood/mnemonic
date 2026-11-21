// Tail lab: latency percentiles, fan-out and aggregation.
//
// After this, the reader can answer: "Why does the average hide what users feel, and why does a
// page that waits for N backends feel the tail of every one of them?"
// Core insight: a rare slow call (1 in 100) barely moves the mean or the median, but a page that
// fans out to 40 backends hits at least one slow call on about a third of its loads
// (1 - 0.99^40). Percentiles from different servers cannot be averaged; their histograms can be
// summed, and the percentile read from the sum.
//
// Three panels, one model:
// 1. One backend call: 2,000 sampled call latencies, a lognormal body around 10 ms plus rare
//    spikes (a GC pause, a cache miss to disk). The reader sets how rare and how big the spikes
//    are and reads mean, p50, p99, p99.9 and max off a log-scale histogram.
// 2. One page = N calls in parallel: 1,000 page loads, each waits for the slowest of N calls.
//    A hedging toggle sends a backup call to another replica once a call passes the call p95.
// 3. Four servers: one is degraded. Averaging the four p99s is compared with the p99 of all
//    requests (summed buckets), as the degraded server's share of traffic changes.
//
// Deterministic: all randomness comes from a seeded PRNG, so tests can assert exact behaviour.

export const CALLS = 2000;
export const PAGES = 1000;
export const MAX_FANOUT = 100;
/** A call or page slower than this counts as slow. */
export const SLOW_MS = 100;
/** The body of the distribution: lognormal, median 10 ms. */
export const BASE_MEDIAN = 10;
const BASE_SIGMA = 0.3;

export const SPIKE_RATES = [0.001, 0.01, 0.05] as const;
export const SPIKE_SIZES = [200, 1000, 5000] as const;

/* ---------------- randomness ---------------- */

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

/** Raw draws: a normal for the body, a uniform to decide a spike, a uniform for its size. */
interface Draws { z: Float64Array; spike: Float64Array; size: Float64Array }
function makeDraws(seed: number, n: number): Draws {
  const r = mulberry32(seed);
  const z = new Float64Array(n), spike = new Float64Array(n), size = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = 1 - r(), u2 = r();
    z[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    spike[i] = r();
    size[i] = r();
  }
  return { z, spike, size };
}
const cache = new Map<string, Draws>();
function draws(seed: number, n: number, salt: number): Draws {
  const k = `${seed}:${n}:${salt}`;
  let d = cache.get(k);
  if (!d) {
    d = makeDraws(seed * 7919 + salt, n);
    if (cache.size > 24) cache.clear();
    cache.set(k, d);
  }
  return d;
}
const latency = (d: Draws, i: number, rate: number, spikeMs: number) =>
  d.spike[i] < rate ? spikeMs * (0.8 + 0.4 * d.size[i]) : BASE_MEDIAN * Math.exp(BASE_SIGMA * d.z[i]);

/* ---------------- statistics ---------------- */

/** Log-spaced buckets: 10 per decade from 1 ms to 10 s, like a Prometheus or HDR histogram. */
export const BUCKETS = 40;
export const bucketEdge = (k: number) => 10 ** (k / 10);
export const bucketOf = (ms: number) => Math.max(0, Math.min(BUCKETS - 1, Math.floor(Math.log10(Math.max(ms, 1)) * 10)));

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
  /** Count per bucket. */
  counts: number[];
  /** Share slower than SLOW_MS. */
  slow: number;
}

/** Nearest-rank percentile of a sorted array, p in (0, 100]. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarise(values: number[]): Summary {
  const s = Float64Array.from(values).sort();
  const counts = new Array(BUCKETS).fill(0);
  let sum = 0, slow = 0;
  for (const v of s) { sum += v; counts[bucketOf(v)]++; if (v > SLOW_MS) slow++; }
  return {
    n: s.length,
    mean: s.length ? sum / s.length : 0,
    p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99), p999: percentile(s, 99.9),
    max: s.length ? s[s.length - 1] : 0,
    counts,
    slow: s.length ? slow / s.length : 0,
  };
}

/** The percentile read from bucket counts alone: the upper edge of the bucket holding the rank. */
export function bucketPercentile(counts: number[], p: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const rank = Math.ceil((p / 100) * total);
  let acc = 0;
  for (let k = 0; k < counts.length; k++) { acc += counts[k]; if (acc >= rank) return bucketEdge(k + 1); }
  return bucketEdge(counts.length);
}

/* ---------------- the three panels ---------------- */

export interface Params { spikeRate: number; spikeMs: number; seed: number }

export function callSample(p: Params): number[] {
  const d = draws(p.seed, CALLS, 1);
  return Array.from({ length: CALLS }, (_, i) => latency(d, i, p.spikeRate, p.spikeMs));
}

export interface FanoutResult {
  page: Summary;
  /** 1 - (1 - spikeRate)^N: the chance at least one of N calls is a spike. */
  formula: number;
  /** The call p95 used as the hedging delay. */
  hedgeAt: number;
  /** Backup calls sent, as a share of all calls (the extra load hedging costs). */
  extraLoad: number;
}

export function fanout(p: Params, n: number, hedge: boolean, hedgeAt: number): FanoutResult {
  const main = draws(p.seed, PAGES * MAX_FANOUT, 2);
  const backup = draws(p.seed, PAGES * MAX_FANOUT, 3);
  const pages: number[] = [];
  let backups = 0;
  for (let i = 0; i < PAGES; i++) {
    let worst = 0;
    for (let j = 0; j < n; j++) {
      const idx = i * MAX_FANOUT + j;
      let l = latency(main, idx, p.spikeRate, p.spikeMs);
      if (hedge && l > hedgeAt) {
        backups++;
        l = Math.min(l, hedgeAt + latency(backup, idx, p.spikeRate, p.spikeMs));
      }
      if (l > worst) worst = l;
    }
    pages.push(worst);
  }
  return { page: summarise(pages), formula: 1 - (1 - p.spikeRate) ** n, hedgeAt, extraLoad: backups / (PAGES * n) };
}

export const SERVERS = ["A", "B", "C", "D"] as const;
export const FLEET_REQUESTS = 4000;
/** Healthy servers spike 1 call in 1,000; the degraded one (D) 1 in 10, for about a second. */
const HEALTHY_RATE = 0.001, DEGRADED_RATE = 0.1, DEGRADED_MS = 1000;

export interface Fleet {
  servers: { name: string; requests: number; p99: number; counts: number[] }[];
  /** What a dashboard that averages per-server p99s shows. */
  avgOfP99: number;
  /** The true p99 of every request in the fleet. */
  trueP99: number;
  /** The p99 read from the four histograms summed bucket by bucket. */
  mergedP99: number;
  merged: number[];
  /** avgOfP99 / trueP99, or its inverse, whichever is at least 1. */
  error: number;
  tooHigh: boolean;
}

export function fleet(seed: number, degradedShare: number): Fleet {
  const d = draws(seed, FLEET_REQUESTS, 4);
  const dCount = Math.round(FLEET_REQUESTS * degradedShare);
  const rest = FLEET_REQUESTS - dCount;
  const sizes = [Math.ceil(rest / 3), Math.ceil((rest - Math.ceil(rest / 3)) / 2), 0, dCount];
  sizes[2] = rest - sizes[0] - sizes[1];
  let at = 0;
  const all: number[] = [];
  const servers = SERVERS.map((name, si) => {
    const vals: number[] = [];
    for (let i = 0; i < sizes[si]; i++, at++) {
      vals.push(si === 3 ? latency(d, at, DEGRADED_RATE, DEGRADED_MS) : latency(d, at, HEALTHY_RATE, 200));
    }
    all.push(...vals);
    const s = summarise(vals);
    return { name, requests: vals.length, p99: s.p99, counts: s.counts };
  });
  const merged = new Array(BUCKETS).fill(0);
  for (const s of servers) s.counts.forEach((c, k) => (merged[k] += c));
  const live = servers.filter((s) => s.requests > 0);
  const avgOfP99 = live.reduce((a, s) => a + s.p99, 0) / live.length;
  const trueP99 = summarise(all).p99;
  const ratio = avgOfP99 / trueP99;
  return { servers, avgOfP99, trueP99, mergedP99: bucketPercentile(merged, 99), merged, error: ratio >= 1 ? ratio : 1 / ratio, tooHigh: ratio >= 1 };
}

/* ---------------- the reader's state ---------------- */

export const CHALLENGES = [
  { id: "half", text: "Find the fan-out at which more than half of all page loads are slow." },
  { id: "mean", text: "Make the mean call more than twice the median while 99 calls in 100 stay exactly as they were." },
  { id: "hedge", text: "At a fan-out of 40 or more with 1% slow calls, get the page p99 under 50 ms." },
  { id: "avg", text: "Make the average of the four p99s more than 5× too high, then more than 3× too low." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export type Guess = "1" | "10" | "33" | "60";

export interface State {
  spikeRate: number;
  spikeMs: number;
  seed: number;
  fanout: number;
  hedge: boolean;
  /** Share of fleet traffic that reaches the degraded server D. */
  share: number;
  guess: Guess | null;
  /** The reader has looked at fan-out 40 with 1% slow calls (reveals the prediction). */
  sawForty: boolean;
  done: ChallengeId[];
  /** avg-of-p99 errors seen: high (too pessimistic) and low (too optimistic). */
  sawHigh: boolean;
  sawLow: boolean;
}

export type Action =
  | { type: "spikeRate"; value: number }
  | { type: "spikeMs"; value: number }
  | { type: "fanout"; value: number }
  | { type: "hedge"; on: boolean }
  | { type: "share"; value: number }
  | { type: "resample" }
  | { type: "guess"; value: Guess }
  | { type: "reset" };

export function init(): State {
  return { spikeRate: 0.01, spikeMs: 200, seed: 1, fanout: 1, hedge: false, share: 0.05, guess: null, sawForty: false, done: [], sawHigh: false, sawLow: false };
}

export interface Analysis {
  call: Summary;
  fan: FanoutResult;
  fleet: Fleet;
}

export function analyse(s: State): Analysis {
  const p = { spikeRate: s.spikeRate, spikeMs: s.spikeMs, seed: s.seed };
  const call = summarise(callSample(p));
  return { call, fan: fanout(p, s.fanout, s.hedge, call.p95), fleet: fleet(s.seed, s.share) };
}

function settle(s: State): State {
  const a = analyse(s);
  const done = new Set(s.done);
  const sawHigh = s.sawHigh || (a.fleet.tooHigh && a.fleet.error > 5);
  const sawLow = s.sawLow || (!a.fleet.tooHigh && a.fleet.error > 3);
  if (a.fan.page.slow > 0.5) done.add("half");
  if (s.spikeRate <= 0.01 && a.call.mean > 2 * a.call.p50) done.add("mean");
  if (s.fanout >= 40 && s.spikeRate >= 0.01 && a.fan.page.p99 < 50) done.add("hedge");
  if (sawHigh && sawLow) done.add("avg");
  return {
    ...s,
    sawHigh, sawLow,
    sawForty: s.sawForty || (s.fanout >= 40 && s.spikeRate === 0.01),
    done: CHALLENGES.map((c) => c.id).filter((id) => done.has(id)),
  };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.guess ? s : { ...s, guess: a.value };
    case "spikeRate": return settle({ ...s, spikeRate: a.value });
    case "spikeMs": return settle({ ...s, spikeMs: a.value });
    case "fanout": return settle({ ...s, fanout: Math.max(1, Math.min(MAX_FANOUT, Math.round(a.value))) });
    case "hedge": return settle({ ...s, hedge: a.on });
    case "share": return settle({ ...s, share: Math.max(0.01, Math.min(0.5, a.value)) });
    case "resample": return settle({ ...s, seed: s.seed + 1 });
  }
}

export const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
export const pct = (x: number) => x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`;
