// Closures-and-decorators playground: stack @lru_cache, @timed and @retry on an API client
// function, then replay the same three calls and watch the call order, the HTTP calls, the
// latency samples and what the decorated function still says about itself.
//
// Purpose. After this, the reader can answer: "What does `@a @b def f` turn f into, which
// wrapper runs first, and what does functools.wraps carry over?" Decorators are applied
// bottom-up when def runs, and the resulting wrappers run top-down on every call. Each wrapper
// only sees what the wrappers above it let through, and without @wraps a wrapper calls itself
// "wrapper", which is the name your metrics and tracebacks will show.
//
// The starting stack looks reasonable and gets three things wrong: cache hits are timed as
// 0 ms, retried attempts are hidden inside one sample but the sample is named "wrapper", and
// cache_info() is not reachable from the outside.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const DECS = ["cache", "timed", "retry"] as const;
export type DecId = (typeof DECS)[number];
export const DEC_LINE: Record<DecId, string> = { cache: "@functools.lru_cache(maxsize=1024)", timed: "@timed", retry: "@retry(times=3)" };
export const DEC_NAME: Record<DecId, string> = { cache: "lru_cache", timed: "timed", retry: "retry" };
export const DEC_JOB: Record<DecId, string> = {
  cache: "Returns a stored result for an argument it has seen. Never stores an exception.",
  timed: "Records how long the call below it took, under that callable's __name__.",
  retry: "Calls again after a connection error, sleeping 200 ms, then 400 ms. Re-raises after 3 tries.",
};

export const BASE_NAME = "fetch_invoice";
export const BASE_SIG = "(invoice_id: str) -> dict";
export const BASE_DOC = "Fetch one invoice from the billing API.";
export const MS_FAIL = 30, MS_OK = 80;

/** The same three calls every run. inv_1 fails its first HTTP attempt; inv_7's upstream is down. */
export const CALLS = [
  { arg: "inv_1", label: "fetch_invoice('inv_1')", why: "first attempt gets a connection reset" },
  { arg: "inv_1", label: "fetch_invoice('inv_1') again", why: "the same invoice, a second later" },
  { arg: "inv_7", label: "fetch_invoice('inv_7')", why: "its shard is down: every attempt resets" },
] as const;

export interface Wraps { timed: boolean; retry: boolean }

export interface TraceLine { depth: number; text: string; kind: "enter" | "http-ok" | "http-fail" | "sleep" | "hit" | "sample" | "raise" | "return" }
export interface Sample { call: number; name: string; ms: number }
export interface CallResult { call: number; ok: boolean; ms: number; http: number; hit: boolean; samples: Sample[]; trace: TraceLine[] }
export interface Meta { name: string; doc: string; signature: string; wrappedDepth: number; cacheInfo: boolean }
export interface Run { stack: DecId[]; wraps: Wraps; calls: CallResult[]; meta: Meta; importOrder: string[] }

/* ---------------- what each layer claims to be ---------------- */

/** __name__ of the callable at layer j (j === stack.length is the original function). */
export function nameAt(stack: DecId[], wraps: Wraps, j: number): string {
  if (j >= stack.length) return BASE_NAME;
  const d = stack[j];
  if (d === "cache") return nameAt(stack, wraps, j + 1); // lru_cache calls update_wrapper itself
  return wraps[d] ? nameAt(stack, wraps, j + 1) : "wrapper";
}
function docAt(stack: DecId[], wraps: Wraps, j: number): string {
  if (j >= stack.length) return BASE_DOC;
  const d = stack[j];
  if (d === "cache" || wraps[d]) return docAt(stack, wraps, j + 1);
  return "None";
}
const hasWrapped = (d: DecId, wraps: Wraps) => d === "cache" || wraps[d];

/** What callers see on the decorated name. inspect.signature follows __wrapped__ as far as it goes. */
export function meta(stack: DecId[], wraps: Wraps): Meta {
  let j = 0;
  while (j < stack.length && hasWrapped(stack[j], wraps)) j++;
  return {
    name: nameAt(stack, wraps, 0),
    doc: docAt(stack, wraps, 0),
    signature: j === stack.length ? BASE_SIG : "(*args, **kwargs)",
    wrappedDepth: j,
    // CPython's lru_cache wrapper is a C type whose cache_info is a method, so an outer
    // @wraps (which copies __dict__) does not carry it over.
    cacheInfo: stack[0] === "cache",
  };
}

/** Decorators apply bottom-up: the one nearest def wraps first. */
export function importOrder(stack: DecId[], wraps: Wraps): string[] {
  const out: string[] = [];
  for (let j = stack.length - 1; j >= 0; j--) {
    const d = stack[j];
    const expr = d === "retry" ? "retry(times=3)" : d === "cache" ? "lru_cache(maxsize=1024)" : "timed";
    out.push(`${expr}(${nameAt(stack, wraps, j + 1)}) → a new callable named ${nameAt(stack, wraps, j)}`);
  }
  out.push(`${BASE_NAME} = the outermost result`);
  return out;
}

/* ---------------- the simulation ---------------- */

/** Replays CALLS through a stack. Pure: the cache, the clock and the upstream live only for this run. */
export function simulate(stack: DecId[], wraps: Wraps): Run {
  const cache = new Set<string>();
  const httpCount = new Map<string, number>();
  let clock = 0;
  const calls: CallResult[] = CALLS.map((c, ci) => {
    const trace: TraceLine[] = [];
    const samples: Sample[] = [];
    let http = 0, hit = false;
    const start = clock;
    const call = (j: number, depth: number): boolean => {
      if (j === stack.length) {
        const n = (httpCount.get(c.arg) ?? 0) + 1;
        httpCount.set(c.arg, n);
        http++;
        const fail = c.arg === "inv_7" || (c.arg === "inv_1" && n === 1);
        clock += fail ? MS_FAIL : MS_OK;
        trace.push({ depth, kind: fail ? "http-fail" : "http-ok", text: fail ? `GET /invoices/${c.arg}: connection reset (${MS_FAIL} ms)` : `GET /invoices/${c.arg}: 200 (${MS_OK} ms)` });
        return !fail;
      }
      const d = stack[j];
      const me = nameAt(stack, wraps, j);
      trace.push({ depth, kind: "enter", text: `${DEC_NAME[d]} wrapper (${me})` });
      if (d === "cache") {
        if (cache.has(c.arg)) { hit = true; trace.push({ depth: depth + 1, kind: "hit", text: "cache hit: returns the stored dict" }); return true; }
        const ok = call(j + 1, depth + 1);
        if (ok) cache.add(c.arg);
        return ok;
      }
      if (d === "timed") {
        const t0 = clock;
        const ok = call(j + 1, depth + 1);
        const s = { call: ci + 1, name: nameAt(stack, wraps, j + 1), ms: clock - t0 };
        samples.push(s);
        trace.push({ depth: depth + 1, kind: "sample", text: `records ${s.ms} ms as "${s.name}"` });
        return ok;
      }
      // retry
      for (let attempt = 0; attempt < 3; attempt++) {
        if (call(j + 1, depth + 1)) return true;
        if (attempt < 2) {
          const ms = 200 * 2 ** attempt;
          clock += ms;
          trace.push({ depth: depth + 1, kind: "sleep", text: `sleeps ${ms} ms, tries again` });
        }
      }
      trace.push({ depth: depth + 1, kind: "raise", text: "gives up: re-raises ConnectError" });
      return false;
    };
    const ok = call(0, 0);
    trace.push({ depth: 0, kind: ok ? "return" : "raise", text: ok ? `returns to the caller after ${clock - start} ms` : `raises ConnectError to the caller after ${clock - start} ms` });
    return { call: ci + 1, ok, ms: clock - start, http, hit, samples, trace };
  });
  return { stack: [...stack], wraps: { ...wraps }, calls, meta: meta(stack, wraps), importOrder: importOrder(stack, wraps) };
}

/* ---------------- goals ---------------- */

export interface Goal { id: string; text: string; met: (r: Run) => boolean }
export const GOALS: Goal[] = [
  { id: "hit", text: "The repeat call makes no HTTP call and records no latency sample.", met: (r) => r.calls[1].http === 0 && r.calls[1].samples.length === 0 },
  { id: "name", text: 'Every latency sample is named "fetch_invoice".', met: (r) => r.calls.some((c) => c.samples.length) && r.calls.every((c) => c.samples.every((s) => s.name === BASE_NAME)) },
  { id: "one", text: "Each fetch that reaches the network records exactly one sample, retries and backoff included.", met: (r) => r.calls.filter((c) => c.http > 0).every((c) => c.samples.length === 1) },
  { id: "intro", text: "fetch_invoice.__name__, inspect.signature and cache_info() all work.", met: (r) => r.meta.name === BASE_NAME && r.meta.signature === BASE_SIG && r.meta.cacheInfo },
];
export const allGoalsMet = (r: Run) => GOALS.every((g) => g.met(r));

export interface Totals { http: number; samples: number; wrapperSamples: number; ms: number; hits: number }
export function totals(r: Run): Totals {
  const all = r.calls.flatMap((c) => c.samples);
  return {
    http: r.calls.reduce((s, c) => s + c.http, 0),
    samples: all.length,
    wrapperSamples: all.filter((s) => s.name !== BASE_NAME).length,
    ms: r.calls.reduce((s, c) => s + c.ms, 0),
    hits: r.calls.filter((c) => c.hit).length,
  };
}

/* ---------------- state ---------------- */

export type Guess = "fetch_invoice" | "wrapper" | "retry";

export interface State {
  /** Outermost first, as written top to bottom above def. */
  stack: DecId[];
  wraps: Wraps;
  guess: Guess | null;
  run: Run | null;
  baseline: Run | null;
  changes: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "send" }
  | { type: "move"; dec: DecId; dir: -1 | 1 }
  | { type: "remove"; dec: DecId }
  | { type: "add"; dec: DecId }
  | { type: "wraps"; dec: "timed" | "retry" }
  | { type: "reset" };

export const START: DecId[] = ["timed", "retry", "cache"];
export const START_WRAPS: Wraps = { timed: true, retry: false };
export const RECOMMENDED: DecId[] = ["cache", "timed", "retry"];

export function init(): State {
  return { stack: [...START], wraps: { ...START_WRAPS }, guess: null, run: null, baseline: null, changes: 0 };
}

function rerun(st: State, stack: DecId[], wraps: Wraps): State {
  if (!st.run) return { ...st, stack, wraps };
  return { ...st, stack, wraps, run: simulate(stack, wraps), changes: st.changes + 1 };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.run ? st : { ...st, guess: a.guess };
    case "send": {
      if (st.run) return st;
      const run = simulate(st.stack, st.wraps);
      return { ...st, run, baseline: run };
    }
    case "move": {
      const i = st.stack.indexOf(a.dec), j = i + a.dir;
      if (i < 0 || j < 0 || j >= st.stack.length) return st;
      const stack = [...st.stack];
      [stack[i], stack[j]] = [stack[j], stack[i]];
      return rerun(st, stack, st.wraps);
    }
    case "remove":
      return st.stack.includes(a.dec) ? rerun(st, st.stack.filter((d) => d !== a.dec), st.wraps) : st;
    case "add":
      // A decorator written on the top line is applied last, so it ends up outermost.
      return st.stack.includes(a.dec) ? st : rerun(st, [a.dec, ...st.stack], st.wraps);
    case "wraps":
      return rerun(st, st.stack, { ...st.wraps, [a.dec]: !st.wraps[a.dec] });
  }
}
