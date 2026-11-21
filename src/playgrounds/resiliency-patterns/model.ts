// Resiliency playground: an API that calls a recommendations service on every request. The
// reader sets the client's timeout, retry count, backoff and circuit breaker, then slows the
// dependency down for a while and runs one simulated minute. Charts show the load reaching the
// dependency (first attempts and retries against its capacity), what users got each second,
// the API's worker pool and the breaker's state. Every run is kept, so configurations can be
// compared on the same outage.
//
// After this, the reader can answer: "When a dependency slows down, which client settings turn
// a short slowdown into a long outage, and which let the system degrade and recover?"
// Core insight: retries multiply load exactly when the dependency has least capacity; without
// a timeout the caller's own workers fill up; immediate retries keep the dependency overloaded
// after the cause is gone. Timeouts, few spaced-out jittered retries and a circuit breaker turn
// the same slowdown into a short, degraded blip.
//
// The simulation is a deterministic fluid model in 100 ms ticks: counts may be fractional.

export type TimeoutOpt = "none" | "5s" | "1s" | "300ms";
export type RetryOpt = 0 | 1 | 3 | "budget";
export type BackoffOpt = "none" | "exp" | "jitter";

export interface Config {
  timeout: TimeoutOpt;
  retries: RetryOpt;
  backoff: BackoffOpt;
  breaker: boolean;
  /** Length of the slowdown in seconds; 0 means no outage. */
  outage: number;
}

export const TIMEOUTS: TimeoutOpt[] = ["none", "5s", "1s", "300ms"];
export const RETRIES: RetryOpt[] = [0, 1, 3, "budget"];
/** "budget": up to 3 retries, but retries may not exceed 10% of first attempts (a token bucket). */
export const maxRetries = (r: RetryOpt) => (r === "budget" ? 3 : r);
export const BUDGET_RATIO = 0.1;
const BUDGET_MAX = 10;
export const BACKOFFS: BackoffOpt[] = ["none", "exp", "jitter"];
export const OUTAGES = [0, 5, 15, 30];

export const DT = 0.1;
export const SECONDS = 60;
const TICKS = SECONDS / DT;
/** Users arriving per tick (100 per second). */
export const USERS_PER_S = 100;
const USERS = USERS_PER_S * DT;
/** Requests the dependency can finish per second, normally and during the slowdown. */
export const CAP_NORMAL = 150;
export const CAP_SLOW = 20;
export const OUTAGE_START = 10;
/** Workers in the API: requests it can hold open at once. */
export const POOL = 400;
/** Requests the dependency will hold in its queue before it rejects new ones (10 s of normal work). */
export const QMAX = 1500;
const TIMEOUT_TICKS: Record<TimeoutOpt, number> = { none: Infinity, "5s": 50, "1s": 10, "300ms": 3 };
/** Exponential backoff: 200 ms, 400 ms, 800 ms ... capped at 5 s. */
const BASE_BACKOFF = 2;
const CAP_BACKOFF = 50;
/** Breaker: opens when at least half of the last second's calls failed (and there were 5+). */
const BREAKER_WINDOW = 10;
const BREAKER_OPEN_TICKS = 50;
const PROBES_PER_TICK = 1;

export type BreakerState = "closed" | "open" | "half";

export interface Second {
  t: number;
  firstAttempts: number;
  retries: number;
  capacity: number;
  /** Work the dependency finished for callers that had already given up. */
  wasted: number;
  queue: number;
  ok: number;
  degraded: number;
  failed: number;
  rejected: number;
  /** Average latency of users who got a real answer or an error this second, in ms. */
  latency: number;
  inFlight: number;
  breaker: BreakerState;
}

export interface Summary {
  users: number;
  ok: number;
  degraded: number;
  failed: number;
  rejected: number;
  attempts: number;
  retries: number;
  wasted: number;
  /** Highest load on the dependency in one second, in requests. */
  peakLoad: number;
  peakInFlight: number;
  /** Seconds after the dependency recovered until users were served normally again; null if never in the minute. */
  recovery: number | null;
  /** Worst one-second average latency, in ms. */
  worstLatency: number;
}

export interface Run { id: number; config: Config; seconds: Second[]; summary: Summary }

interface Item { n: number; sent: number; deadline: number; userStart: number; attempt: number; abandoned: boolean; probe: boolean }
interface Due { n: number; userStart: number; attempt: number }

const timeoutTicks = (c: Config) => TIMEOUT_TICKS[c.timeout];
const capacityAt = (tick: number, c: Config) => {
  const s = tick * DT;
  return (c.outage > 0 && s >= OUTAGE_START && s < OUTAGE_START + c.outage ? CAP_SLOW : CAP_NORMAL) * DT;
};

/** Run one simulated minute. Pure and deterministic. */
export function simulate(c: Config): { seconds: Second[]; summary: Summary } {
  const T = timeoutTicks(c);
  const queue: Item[] = [];
  let head = 0;
  const due: Due[][] = Array.from({ length: TICKS + CAP_BACKOFF + 2 }, () => []);
  let inFlight = 0;
  let breaker: BreakerState = "closed";
  let openUntil = 0;
  let probeOk = 0, probeBad = 0;
  const outcomeWindow: { ok: number; bad: number }[] = [];
  const seconds: Second[] = [];
  let cur = blank(0);

  function blank(t: number): Second {
    return { t, firstAttempts: 0, retries: 0, capacity: 0, wasted: 0, queue: 0, ok: 0, degraded: 0, failed: 0, rejected: 0, latency: 0, inFlight: 0, breaker: "closed" };
  }
  let latSum = 0, latN = 0;
  let queued = 0;
  let tokens = BUDGET_MAX;

  /** An attempt failed: retry it if the policy allows, otherwise the user gets an error. */
  function giveUpOrRetry(tick: number, n: number, userStart: number, attempt: number) {
    let retry = attempt <= maxRetries(c.retries) ? n : 0;
    if (retry > 0 && c.retries === "budget") { retry = Math.min(retry, tokens); tokens -= retry; }
    if (retry > 0) schedule(due, tick, retry, userStart, attempt + 1, c);
    const fail = n - retry;
    if (fail > 0) {
      cur.failed += fail;
      inFlight -= fail;
      latSum += (tick - userStart + 1) * fail; latN += fail;
    }
  }

  for (let tick = 0; tick < TICKS; tick++) {
    let tickOk = 0, tickBad = 0;
    // Breaker timer.
    if (breaker === "open" && tick >= openUntil) { breaker = "half"; probeOk = 0; probeBad = 0; }
    let probes = PROBES_PER_TICK;

    // Who wants to call the dependency this tick: new users, then retries that are due.
    const wanting: Due[] = [];
    const room = Math.max(0, POOL - inFlight);
    const admitted = Math.min(USERS, room);
    cur.rejected += USERS - admitted;
    inFlight += admitted;
    if (admitted > 0) wanting.push({ n: admitted, userStart: tick, attempt: 1 });
    for (const d of due[tick]) wanting.push(d);

    for (const w of wanting) {
      let n = w.n;
      if (c.breaker && breaker !== "closed") {
        // Open: fail fast with a fallback. Half-open: let a few probes through.
        let pass = 0;
        if (breaker === "half") { pass = Math.min(n, probes); probes -= pass; }
        const fallback = n - pass;
        if (fallback > 0) { cur.degraded += fallback; inFlight -= fallback; }
        n = pass;
        if (n <= 0) continue;
      }
      if (w.attempt === 1) { cur.firstAttempts += n; tokens = Math.min(BUDGET_MAX, tokens + n * BUDGET_RATIO); } else cur.retries += n;
      const accepted = Math.min(n, Math.max(0, QMAX - queued));
      if (accepted > 0) {
        queue.push({ n: accepted, sent: tick, deadline: tick + T - 1, userStart: w.userStart, attempt: w.attempt, abandoned: false, probe: c.breaker && breaker === "half" });
        queued += accepted;
      }
      if (n - accepted > 0) {
        // The dependency's queue is full: it rejects at once with an error.
        tickBad += n - accepted;
        giveUpOrRetry(tick, n - accepted, w.userStart, w.attempt);
      }
    }

    // The dependency works through its queue, oldest first.
    let cap = capacityAt(tick, c);
    cur.capacity += cap;
    while (cap > 1e-9 && head < queue.length) {
      const it = queue[head];
      const take = Math.min(it.n, cap);
      cap -= take;
      it.n -= take;
      queued -= take;
      if (it.abandoned) cur.wasted += take;
      else {
        cur.ok += take;
        inFlight -= take;
        latSum += (tick - it.userStart + 1) * take; latN += take;
        tickOk += take;
        if (it.probe) probeOk += take;
      }
      if (it.n <= 1e-9) head++;
    }

    // Callers whose deadline is now give up on what is still queued.
    if (T !== Infinity) {
      for (let i = head; i < queue.length; i++) {
        const it = queue[i];
        if (it.sent > tick - T + 1) break;
        if (it.abandoned || it.n <= 1e-9) continue;
        it.abandoned = true;
        tickBad += it.n;
        if (it.probe) probeBad += it.n;
        giveUpOrRetry(tick, it.n, it.userStart, it.attempt);
      }
    }

    // Breaker decisions.
    if (c.breaker) {
      outcomeWindow.push({ ok: tickOk, bad: tickBad });
      if (outcomeWindow.length > BREAKER_WINDOW) outcomeWindow.shift();
      if (breaker === "closed") {
        const ok = outcomeWindow.reduce((a, x) => a + x.ok, 0), bad = outcomeWindow.reduce((a, x) => a + x.bad, 0);
        if (ok + bad >= 5 && bad >= (ok + bad) / 2) { breaker = "open"; openUntil = tick + BREAKER_OPEN_TICKS; outcomeWindow.length = 0; }
      } else if (breaker === "half" && probeOk + probeBad >= 3) {
        if (probeOk >= 0.8 * (probeOk + probeBad)) { breaker = "closed"; outcomeWindow.length = 0; }
        else { breaker = "open"; openUntil = tick + BREAKER_OPEN_TICKS; }
      }
    }

    // Close the second.
    if ((tick + 1) % 10 === 0) {
      let q = 0;
      for (let i = head; i < queue.length; i++) q += queue[i].n;
      cur.queue = q;
      cur.inFlight = Math.max(0, inFlight);
      cur.breaker = c.breaker ? breaker : "closed";
      cur.latency = latN > 0 ? (latSum / latN) * 100 : 0;
      seconds.push(round(cur));
      latSum = 0; latN = 0;
      cur = blank(seconds.length);
    }
  }
  return { seconds, summary: summarise(seconds, c) };
}

function schedule(due: Due[][], tick: number, n: number, userStart: number, attempt: number, c: Config) {
  const failedAttempt = attempt - 1;
  const wait = c.backoff === "none" ? 0 : Math.min(CAP_BACKOFF, BASE_BACKOFF * 2 ** (failedAttempt - 1));
  if (c.backoff === "jitter") {
    // Full jitter: a uniform random wait between 0 and the exponential backoff.
    const parts = wait + 1;
    for (let j = 0; j <= wait; j++) put(due, tick + 1 + j, { n: n / parts, userStart, attempt });
  } else {
    put(due, tick + 1 + wait, { n, userStart, attempt });
  }
}
function put(due: Due[][], at: number, d: Due) {
  if (at < due.length) due[at].push(d);
}

const r1 = (x: number) => Math.round(x * 10) / 10;
function round(s: Second): Second {
  return { ...s, firstAttempts: r1(s.firstAttempts), retries: r1(s.retries), capacity: r1(s.capacity), wasted: r1(s.wasted), queue: r1(s.queue), ok: r1(s.ok), degraded: r1(s.degraded), failed: r1(s.failed), rejected: r1(s.rejected), latency: Math.round(s.latency), inFlight: r1(s.inFlight) };
}

/** A second counts as healthy when at least 95% of the users arriving got a real answer. */
export const healthy = (s: Second) => s.ok >= 0.95 * USERS_PER_S && s.degraded + s.failed + s.rejected < 0.05 * USERS_PER_S;

function summarise(seconds: Second[], c: Config): Summary {
  const sum = (f: (s: Second) => number) => Math.round(seconds.reduce((a, s) => a + f(s), 0));
  const end = OUTAGE_START + c.outage;
  let recovery: number | null = null;
  if (c.outage > 0) {
    for (let t = end; t < seconds.length; t++) {
      const run = seconds.slice(t, t + 5);
      if (run.length === 5 && run.every(healthy)) { recovery = t - end; break; }
    }
  } else recovery = 0;
  return {
    users: SECONDS * USERS_PER_S,
    ok: sum((s) => s.ok),
    degraded: sum((s) => s.degraded),
    failed: sum((s) => s.failed),
    rejected: sum((s) => s.rejected),
    attempts: sum((s) => s.firstAttempts + s.retries),
    retries: sum((s) => s.retries),
    wasted: sum((s) => s.wasted),
    peakLoad: Math.round(Math.max(...seconds.map((s) => s.firstAttempts + s.retries))),
    peakInFlight: Math.round(Math.max(...seconds.map((s) => s.inFlight))),
    recovery,
    worstLatency: Math.max(...seconds.map((s) => s.latency)),
  };
}

/* ---------------- the reader's state ---------------- */

export const PRESETS: { id: string; label: string; config: Omit<Config, "outage"> }[] = [
  { id: "naive", label: "Eager retries", config: { timeout: "1s", retries: 3, backoff: "none", breaker: false } },
  { id: "patient", label: "No timeout", config: { timeout: "none", retries: 0, backoff: "none", breaker: false } },
  { id: "polite", label: "Backoff + jitter", config: { timeout: "1s", retries: 3, backoff: "jitter", breaker: false } },
  { id: "kit", label: "Full kit", config: { timeout: "1s", retries: 1, backoff: "jitter", breaker: true } },
];

export interface State {
  config: Config;
  runs: Run[];
  /** The run on screen. */
  shown: number | null;
  seq: number;
  prediction: string | null;
}

export type Action =
  | { type: "set"; patch: Partial<Config> }
  | { type: "preset"; id: string }
  | { type: "run" }
  | { type: "show"; id: number }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { config: { ...PRESETS[0].config, outage: 15 }, runs: [], shown: null, seq: 1, prediction: null };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "set":
      return { ...s, config: { ...s.config, ...a.patch } };
    case "preset": {
      const p = PRESETS.find((x) => x.id === a.id);
      return p ? { ...s, config: { ...p.config, outage: s.config.outage } } : s;
    }
    case "run": {
      const r = simulate(s.config);
      const run: Run = { id: s.seq, config: { ...s.config }, ...r };
      return { ...s, runs: [run, ...s.runs].slice(0, 5), shown: run.id, seq: s.seq + 1 };
    }
    case "show":
      return s.runs.some((r) => r.id === a.id) ? { ...s, shown: a.id } : s;
  }
}

export const shownRun = (s: State) => s.runs.find((r) => r.id === s.shown) ?? null;

export function describe(c: Config): string {
  const t = c.timeout === "none" ? "no timeout" : `${c.timeout} timeout`;
  const how = c.backoff === "none" ? " at once" : c.backoff === "exp" ? " with backoff" : " with backoff + jitter";
  const r = c.retries === 0 ? "no retries" : c.retries === "budget" ? `retries within a 10% budget${how}` : `${c.retries} ${c.retries === 1 ? "retry" : "retries"}${how}`;
  return `${t}, ${r}${c.breaker ? ", breaker" : ""}`;
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "storm", text: "Make a 15-second slowdown last the whole minute: the dependency is back, but users are not." },
  { id: "pool", text: "Fill the API's worker pool, so users are turned away by the API itself." },
  { id: "recover", text: "With a 15-second slowdown, be serving users normally within 3 seconds of the dependency recovering." },
  { id: "degrade", text: "Get through a 15-second slowdown with fewer than 100 users seeing an error." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  return s.runs.some((r) => {
    const m = r.summary;
    switch (id) {
      case "storm": return r.config.outage >= 15 && m.recovery === null;
      case "pool": return m.rejected > 0;
      case "recover": return r.config.outage === 15 && m.recovery !== null && m.recovery <= 3;
      case "degrade": return r.config.outage === 15 && m.failed + m.rejected < 100;
    }
  });
}
