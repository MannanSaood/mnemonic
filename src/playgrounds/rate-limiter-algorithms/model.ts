// Rate limiter playground: the same traffic through five limiters side by side.
//
// After this, the reader can answer: "Given a limit of r requests per second, what does each
// algorithm actually let through, and where does each one break?"
// Core insight: they agree on steady traffic and disagree on bursts. A fixed window resets its
// count at the boundary, so a burst on each side of it gets 2r through in a fraction of a second.
// The token bucket admits a burst of b on purpose; the leaky bucket smooths the burst by delaying
// it; the sliding log is exact and the sliding counter close to it. And any of them leaks when
// two gateways read and write the shared counter without an atomic update.
//
// Pure and deterministic: arrivals are millisecond timestamps over a 4-second timeline.

export const SPAN = 4000;
export const SLOT = 100;
export const SLOTS = SPAN / SLOT;
export const WINDOW = 1000;
/** Requests that arrive in the same tick are concurrent when two gateways share the store. */
export const TICK = 50;

export type Algo = "token" | "leaky" | "fixed" | "log" | "counter";
export const ALGOS: Algo[] = ["token", "leaky", "fixed", "log", "counter"];
export const ALGO_NAME: Record<Algo, string> = {
  token: "Token bucket",
  leaky: "Leaky bucket",
  fixed: "Fixed window",
  log: "Sliding log",
  counter: "Sliding counter",
};
export const ALGO_RULE: Record<Algo, string> = {
  token: "tokens refill at r/s up to b; each request spends one",
  leaky: "a queue of b drains at r/s; requests wait their turn",
  fixed: "at most r per clock second; the count resets on the second",
  log: "at most r timestamps in the trailing second",
  counter: "last second's count × overlap + this second's count < r",
};
/** Which knobs each algorithm uses. */
export const USES_BURST: Record<Algo, boolean> = { token: true, leaky: true, fixed: false, log: false, counter: false };

export const RATES = [5, 10, 20] as const;
export const BURSTS = [1, 5, 10, 20] as const;
export type Rate = (typeof RATES)[number];
export type Burst = (typeof BURSTS)[number];

export interface Config { rate: Rate; burst: Burst; race: boolean }

/* ---------------- the limiters: pure state machines ---------------- */

type LState =
  | { k: "token"; tokens: number; last: number }
  | { k: "leaky"; nextFree: number }
  | { k: "fixed"; win: number; count: number }
  | { k: "log"; times: number[] }
  | { k: "counter"; win: number; cur: number; prev: number };

function fresh(a: Algo, c: Config): LState {
  switch (a) {
    case "token": return { k: "token", tokens: c.burst, last: 0 };
    case "leaky": return { k: "leaky", nextFree: 0 };
    case "fixed": return { k: "fixed", win: 0, count: 0 };
    case "log": return { k: "log", times: [] };
    case "counter": return { k: "counter", win: 0, cur: 0, prev: 0 };
  }
}

/** Decide one request at time t. Returns the new state and, if admitted, when it reaches the backend. */
function decide(s: LState, t: number, c: Config): { s: LState; out: number | null } {
  const r = c.rate;
  switch (s.k) {
    case "token": {
      const tokens = Math.min(c.burst, s.tokens + ((t - s.last) * r) / 1000);
      return tokens >= 1 - 1e-9 ? { s: { k: "token", tokens: tokens - 1, last: t }, out: t } : { s: { k: "token", tokens, last: t }, out: null };
    }
    case "leaky": {
      const nf = Math.max(s.nextFree, t);
      const depth = ((nf - t) * r) / 1000;
      return depth + 1 <= c.burst + 1e-9 ? { s: { k: "leaky", nextFree: nf + 1000 / r }, out: nf } : { s, out: null };
    }
    case "fixed": {
      const w = Math.floor(t / WINDOW);
      const count = w === s.win ? s.count : 0;
      return count < r ? { s: { k: "fixed", win: w, count: count + 1 }, out: t } : { s: { k: "fixed", win: w, count }, out: null };
    }
    case "log": {
      const times = s.times.filter((x) => x > t - WINDOW);
      return times.length < r ? { s: { k: "log", times: [...times, t] }, out: t } : { s: { k: "log", times }, out: null };
    }
    case "counter": {
      const w = Math.floor(t / WINDOW);
      let { cur, prev } = s;
      if (w === s.win + 1) { prev = cur; cur = 0; } else if (w > s.win + 1) { prev = 0; cur = 0; }
      const elapsed = (t % WINDOW) / WINDOW;
      const est = prev * (1 - elapsed) + cur;
      return est < r ? { s: { k: "counter", win: w, cur: cur + 1, prev }, out: t } : { s: { k: "counter", win: w, cur, prev }, out: null };
    }
  }
}

export interface Decision { t: number; ok: boolean; out: number | null; node: 0 | 1 }

export interface Lane {
  algo: Algo;
  decisions: Decision[];
  admitted: number;
  rejected: number;
  /** Most requests reaching the backend in any 1-second span, and where that span starts. */
  peak: number;
  peakAt: number;
  /** Longest wait between arrival and reaching the backend, in ms. */
  maxDelay: number;
}

/** Most timestamps in any half-open span [x, x + WINDOW). */
export function busiest(times: number[]): { n: number; at: number } {
  const ts = [...times].sort((a, b) => a - b);
  let best = 0, at = 0, j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= WINDOW) j++;
    if (i - j + 1 > best) { best = i - j + 1; at = ts[j]; }
  }
  return { n: best, at };
}

/**
 * Run one limiter over the arrivals. With race on, requests alternate between two gateways;
 * inside each tick both gateways read the same stored state, decide on their own requests, and
 * write back, and the second write wins (a lost update).
 */
export function runLane(algo: Algo, arrivals: number[], c: Config): Lane {
  const ts = [...arrivals].sort((a, b) => a - b);
  let state = fresh(algo, c);
  const decisions: Decision[] = [];
  if (!c.race) {
    for (const t of ts) {
      const d = decide(state, t, c);
      state = d.s;
      decisions.push({ t, ok: d.out !== null, out: d.out, node: 0 });
    }
  } else {
    let i = 0, n = 0;
    while (i < ts.length) {
      const tick = Math.floor(ts[i] / TICK);
      const batch: { t: number; node: 0 | 1 }[] = [];
      while (i < ts.length && Math.floor(ts[i] / TICK) === tick) batch.push({ t: ts[i++], node: (n++ % 2) as 0 | 1 });
      const snap = state;
      const per: LState[] = [snap, snap];
      const local: Decision[] = [];
      for (const b of batch) {
        const d = decide(per[b.node], b.t, c);
        per[b.node] = d.s;
        local.push({ t: b.t, ok: d.out !== null, out: d.out, node: b.node });
      }
      decisions.push(...local);
      // Last writer wins: gateway 1 writes last if it handled anything, else gateway 0.
      state = batch.some((b) => b.node === 1) ? per[1] : per[0];
    }
  }
  const outs = decisions.filter((d) => d.ok).map((d) => d.out as number);
  const peak = busiest(outs);
  return {
    algo, decisions,
    admitted: outs.length,
    rejected: decisions.length - outs.length,
    peak: peak.n, peakAt: peak.at,
    maxDelay: Math.round(Math.max(0, ...decisions.filter((d) => d.ok).map((d) => (d.out as number) - d.t))),
  };
}

export const runAll = (arrivals: number[], c: Config): Lane[] => ALGOS.map((a) => runLane(a, arrivals, c));

/* ---------------- traffic ---------------- */

const range = (from: number, to: number, every: number) => {
  const out: number[] = [];
  for (let t = from; t < to; t += every) out.push(Math.round(t));
  return out;
};

export type Pattern = "steady" | "boundary" | "burst" | "storm";
export const PATTERN_NAME: Record<Pattern, string> = {
  steady: "Steady 8/s",
  boundary: "Boundary burst",
  burst: "One big burst",
  storm: "Retry waves",
};

/** Traffic patterns, scaled to the rate so they mean the same thing at every limit. */
export function pattern(p: Pattern, rate: Rate): number[] {
  switch (p) {
    case "steady": return range(0, SPAN, 1000 / (rate * 0.8));
    // r requests in the last 100 ms of second 0, r more in the first 100 ms of second 1.
    case "boundary": return [...range(900, 1000, 100 / rate), ...range(1000, 1100, 100 / rate)];
    case "burst": return [...range(500, 700, 200 / (rate * 3)), ...range(1500, SPAN, 1000 / (rate / 2))];
    case "storm": return [0, 1000, 2000, 3000].flatMap((s) => range(s, s + 150, 150 / (rate * 1.5)));
  }
}

/* ---------------- the reader's state ---------------- */

export const CHALLENGES = [
  { id: "double", text: "Get the fixed window to let through at least 1.8× its limit within one second." },
  { id: "shaped", text: "Make the leaky bucket hold a request back for more than half a second." },
  { id: "burstOnly", text: "Find traffic the token bucket admits in full but the sliding log partly rejects." },
  { id: "race", text: "Turn on two gateways and push the sliding log past its limit within one second." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  config: Config;
  arrivals: number[];
  pattern: Pattern | "custom";
  prediction: string | null;
  sawBoundary: boolean;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "pattern"; pattern: Pattern }
  | { type: "slot"; slot: number }
  | { type: "clear" }
  | { type: "rate"; rate: Rate }
  | { type: "burst"; burst: Burst }
  | { type: "race"; on: boolean }
  | { type: "predict"; value: string }
  | { type: "reset" };

/** Requests added by one click on a timeline slot. */
export const PER_CLICK = 5;

export function init(): State {
  const config: Config = { rate: 10, burst: 10, race: false };
  return { config, arrivals: pattern("steady", 10), pattern: "steady", prediction: null, sawBoundary: false, done: { double: false, shaped: false, burstOnly: false, race: false } };
}

function score(s: State): State {
  const lanes = runAll(s.arrivals, s.config);
  const by = Object.fromEntries(lanes.map((l) => [l.algo, l])) as Record<Algo, Lane>;
  const d = { ...s.done };
  const r = s.config.rate;
  if (by.fixed.peak >= 1.8 * r) d.double = true;
  if (by.leaky.maxDelay > 500) d.shaped = true;
  if (by.token.rejected === 0 && by.log.rejected > 0) d.burstOnly = true;
  if (s.config.race && by.log.peak > r) d.race = true;
  return { ...s, done: d };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "pattern":
      return score({ ...s, arrivals: pattern(a.pattern, s.config.rate), pattern: a.pattern, sawBoundary: s.sawBoundary || a.pattern === "boundary" });
    case "slot": {
      if (a.slot < 0 || a.slot >= SLOTS) return s;
      const added = Array.from({ length: PER_CLICK }, (_, i) => a.slot * SLOT + Math.round(((i + 0.5) * SLOT) / PER_CLICK));
      return score({ ...s, arrivals: [...s.arrivals, ...added].sort((x, y) => x - y), pattern: "custom" });
    }
    case "clear":
      return { ...s, arrivals: [], pattern: "custom" };
    case "rate": {
      const config = { ...s.config, rate: a.rate };
      const arrivals = s.pattern === "custom" ? s.arrivals : pattern(s.pattern, a.rate);
      return score({ ...s, config, arrivals });
    }
    case "burst":
      return score({ ...s, config: { ...s.config, burst: a.burst } });
    case "race":
      return score({ ...s, config: { ...s.config, race: a.on } });
  }
}

/** Requests per 100 ms slot, for the traffic strip. */
export function histogram(arrivals: number[]): number[] {
  const h = new Array(SLOTS).fill(0);
  for (const t of arrivals) if (t >= 0 && t < SPAN) h[Math.floor(t / SLOT)]++;
  return h;
}
