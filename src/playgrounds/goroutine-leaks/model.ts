// Goroutine leak playground: a profile handler that asks three backends at once and returns the
// first answer (or gives up after 100 ms). The reader sends real traffic through it, watches
// parked goroutines pile up in the pod until it is OOM-killed, then fixes the handler with a
// channel buffer, a context, or both, and compares the runs.
//
// Purpose. After this, the reader can answer: "Why does a handler that returns early leave
// goroutines behind, and what makes the count go back to zero?" Every sender that finishes after
// the handler stopped reading parks on the channel forever, unless there is a free slot for it
// or it was told to stop before it got there. A buffer of 1 is not enough for three senders.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const BACKENDS = ["primary", "replica-a", "replica-b"] as const;
export const TIMEOUT_MS = 100;
/** Memory a parked goroutine keeps alive: its stack (2 KiB minimum) plus the profile it holds. */
export const KIB_PER_LEAK = 8;
export const POD_LIMIT_MIB = 64;
export const BASE_MIB = 24;
/** Goroutines a healthy pod runs anyway (HTTP server, pools, tickers). */
export const BASE_GOROUTINES = 12;

export type BufSize = 0 | 1 | 2 | 3;
export interface Fix { buf: BufSize; ctx: boolean }
export const ORIGINAL: Fix = { buf: 0, ctx: false };

/** What became of one backend goroutine. */
export type Fate =
  | "read"      // the winner: the handler received its value
  | "slot"      // sent into a free buffer slot after the handler left, then exited
  | "leaked"    // sent after the handler left, no free slot: parked on ch forever
  | "cancelled" // still in flight when the handler returned; ctx cancelled the call, it exited
  | "error";    // the backend failed; nothing to send, it exited

export interface Lane { backend: string; t: number; ok: boolean; fate: Fate; wastedMs: number }
export interface Req { id: number; lanes: Lane[]; returnAt: number; timedOut: boolean; leaked: number }

export interface Totals { requests: number; leaked: number; wastedMs: number; timeouts: number }
const zero = (): Totals => ({ requests: 0, leaked: 0, wastedMs: 0, timeouts: 0 });

export interface Pod { leaked: number; restarts: number; served: number }

/** One row per handler version the reader has run traffic through. */
export interface RunRow { fix: Fix; totals: Totals }

export type Guess = "zero" | "one" | "losers";
export const ANSWER: Guess = "losers";

export interface State {
  fix: Fix;
  guess: Guess | null;
  pod: Pod;
  /** Since the last deploy. */
  totals: Totals;
  last: Req | null;
  runs: RunRow[];
  /** Request ids continue across deploys, so each request's latencies are fixed. */
  seq: number;
  event: string | null;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "send"; n: number }
  | { type: "setBuf"; buf: BufSize }
  | { type: "setCtx"; ctx: boolean }
  | { type: "reset" };

export function init(): State {
  return { fix: { ...ORIGINAL }, guess: null, pod: { leaked: 0, restarts: 0, served: 0 }, totals: zero(), last: null, runs: [], seq: 0, event: null };
}

/* ---------------- the simulation ---------------- */

function rand(seed: number) {
  let t = seed * 2654435761 + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One request through the handler. Pure: the same id always gets the same latencies. */
export function simulate(id: number, fix: Fix): Req {
  const r = rand(id);
  const slow = r() < 0.03; // all three backends stuck behind a slow disk: the request times out
  const raw = BACKENDS.map((backend, i) => {
    const base = slow ? 110 + 190 * r() : i === 0 ? 20 + 40 * r() : 15 + 75 * r();
    return { backend, i, t: Math.round(base), ok: r() >= 0.04 };
  });
  const order = [...raw].sort((a, b) => a.t - b.t || a.i - b.i);
  const winner = order.find((l) => l.ok && l.t < TIMEOUT_MS) ?? null;
  const returnAt = winner ? winner.t : TIMEOUT_MS;
  let slots = 0;
  const fates = new Map<number, { fate: Fate; wastedMs: number }>();
  for (const l of order) {
    if (fix.ctx && l.t > returnAt) { fates.set(l.i, { fate: "cancelled", wastedMs: 0 }); continue; }
    const wastedMs = Math.max(0, l.t - returnAt);
    if (!l.ok) { fates.set(l.i, { fate: "error", wastedMs }); continue; }
    if (l === winner) { fates.set(l.i, { fate: "read", wastedMs: 0 }); continue; }
    // The handler has stopped reading: only a free slot lets this send finish.
    if (slots < fix.buf) { slots++; fates.set(l.i, { fate: "slot", wastedMs }); }
    else fates.set(l.i, { fate: "leaked", wastedMs });
  }
  const lanes: Lane[] = raw.map((l) => ({ backend: l.backend, t: l.t, ok: l.ok, ...fates.get(l.i)! }));
  return { id, lanes, returnAt, timedOut: !winner, leaked: lanes.filter((l) => l.fate === "leaked").length };
}

export const memMiB = (leaked: number) => BASE_MIB + (leaked * KIB_PER_LEAK) / 1024;
export const goroutines = (pod: Pod) => BASE_GOROUTINES + pod.leaked;
/** Leaked goroutines that fit before the pod hits its memory limit. */
export const LEAKS_TO_OOM = Math.floor(((POD_LIMIT_MIB - BASE_MIB) * 1024) / KIB_PER_LEAK);

const sameFix = (a: Fix, b: Fix) => a.buf === b.buf && a.ctx === b.ctx;

function record(runs: RunRow[], fix: Fix, add: Totals): RunRow[] {
  const i = runs.findIndex((r) => sameFix(r.fix, fix));
  const plus = (t: Totals): Totals => ({ requests: t.requests + add.requests, leaked: t.leaked + add.leaked, wastedMs: t.wastedMs + add.wastedMs, timeouts: t.timeouts + add.timeouts });
  if (i < 0) return [...runs, { fix: { ...fix }, totals: plus(zero()) }];
  return runs.map((r, j) => (j === i ? { ...r, totals: plus(r.totals) } : r));
}

function deploy(st: State, fix: Fix): State {
  if (sameFix(st.fix, fix)) return st;
  // A deploy restarts the pod: the leaked goroutines go away with the old process.
  return { ...st, fix, pod: { leaked: 0, restarts: st.pod.restarts, served: st.pod.served }, totals: zero(), last: null, event: `Deployed. The pod restarted, so the count starts again from ${BASE_GOROUTINES} goroutines.` };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.totals.requests > 0 || st.runs.length ? st : { ...st, guess: a.guess };
    case "setBuf":
      return deploy(st, { ...st.fix, buf: a.buf });
    case "setCtx":
      return deploy(st, { ...st.fix, ctx: a.ctx });
    case "send": {
      const n = Math.max(1, Math.min(10000, Math.floor(a.n)));
      const pod = { ...st.pod };
      const totals = { ...st.totals };
      const add = zero();
      let last: Req | null = null;
      let event: string | null = null;
      let seq = st.seq;
      for (let k = 0; k < n; k++) {
        const req = simulate(++seq, st.fix);
        last = req;
        pod.served++;
        pod.leaked += req.leaked;
        for (const t of [totals, add]) {
          t.requests++;
          t.leaked += req.leaked;
          t.wastedMs += req.lanes.reduce((s, l) => s + l.wastedMs, 0);
          if (req.timedOut) t.timeouts++;
        }
        if (pod.leaked > LEAKS_TO_OOM) {
          event = `OOMKilled at ${POD_LIMIT_MIB} MiB after ${pod.leaked.toLocaleString("en-US")} parked goroutines. The pod restarted; requests in flight failed.`;
          pod.restarts++;
          pod.leaked = 0;
        }
      }
      return { ...st, seq, pod, totals, last, event, runs: record(st.runs, st.fix, add) };
    }
  }
}

/** Leaked goroutines per 1,000 requests for a run row. */
export const leakRate = (t: Totals) => (t.requests ? (t.leaked * 1000) / t.requests : 0);
