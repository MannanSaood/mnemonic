// Proxy playground: two minutes of real traffic against a paid, slow exchange-rates API.
//
// After this, the reader can answer: what does a proxy buy, and what does it cost, when it
// stands in front of a slow remote service with the same interface? (Callers change 0 lines,
// vendor calls and latency drop; in exchange you get stale answers, and the order of the proxies
// decides who is let through.)
//
// The reader builds a chain of proxies between the callers and the vendor (access guard, cache,
// lazy connect), replays the same traffic, and compares runs. Break-it switches move a rate mid-run
// or take the vendor down. Plain state + a pure step function, so it can be tested without a browser.

export type Layer = "guard" | "cache" | "lazy";
export const LAYERS: Layer[] = ["guard", "cache", "lazy"];
export const LAYER_NAME: Record<Layer, string> = { guard: "GuardedRates", cache: "CachedRates", lazy: "LazyRates" };
export const LAYER_JOB: Record<Layer, string> = {
  guard: "protection proxy: refuses callers without the rates:read scope",
  cache: "caching proxy: answers repeat questions from memory until the TTL runs out",
  lazy: "virtual proxy: opens the vendor connection on the first call, not at startup",
};

export type Caller = "checkout" | "invoices" | "export";
export const CALLER_NAME: Record<Caller, string> = { checkout: "checkout", invoices: "invoice job", export: "export script" };
/** Only these callers hold the rates:read scope. The export script is a runaway job without it. */
export const SCOPED: Record<Caller, boolean> = { checkout: true, invoices: true, export: false };

export type Pair = "EUR/USD" | "GBP/USD" | "USD/JPY";
export type Ttl = 10 | 60 | 600;
export const TTLS: Ttl[] = [10, 60, 600];

/** Vendor facts (illustrative, in line with common FX APIs). */
export const VENDOR_MS = 300;
export const CONNECT_MS = 800;
export const TIMEOUT_MS = 2000;
export const HIT_MS = 1;
export const PRICE_PER_CALL = 0.002; // dollars
export const RUN_SECONDS = 120;
/** Calls in one run, scaled up to 30 days of the same traffic. */
export const monthly = (calls: number) => calls * (30 * 24 * 3600 / RUN_SECONDS) * PRICE_PER_CALL;

export interface Breaks { rateMove: boolean; outage: boolean }

export interface Request { t: number; caller: Caller; pair: Pair }
export interface Trace { id: number; ok: boolean; text: string; path: string[] }

export interface Run {
  n: number;
  chain: Layer[];
  ttl: Ttl;
  breaks: Breaks;
  vendorCalls: number;
  vendorByCaller: Record<Caller, number>;
  checkoutAvgMs: number;
  stale: number;
  errors: number;
  denied: number;
  /** Answers given to a caller that does not hold the scope. */
  unauthorized: number;
  startupMs: number;
  traces: Trace[];
}

export interface State { chain: Layer[]; ttl: Ttl; breaks: Breaks; runs: Run[] }

export type Action =
  | { type: "add"; layer: Layer }
  | { type: "remove"; layer: Layer }
  | { type: "move"; layer: Layer; dir: -1 | 1 }
  | { type: "ttl"; ttl: Ttl }
  | { type: "break"; kind: keyof Breaks }
  | { type: "run" }
  | { type: "reset" };

export function init(): State {
  return { chain: [], ttl: 60, breaks: { rateMove: false, outage: false }, runs: [] };
}

/* ---------------- traffic and vendor ---------------- */

const CHECKOUT_PAIRS: Pair[] = ["EUR/USD", "EUR/USD", "EUR/USD", "EUR/USD", "EUR/USD", "EUR/USD", "GBP/USD", "GBP/USD", "GBP/USD", "USD/JPY"];

/** The same two minutes every run: checkout once a second, the invoice job's batch at 1:00, a runaway export at 1:30. */
export function traffic(): Request[] {
  const out: Request[] = [];
  for (let t = 0; t < RUN_SECONDS; t++) {
    out.push({ t, caller: "checkout", pair: CHECKOUT_PAIRS[t % 10] });
    if (t === 60) for (let i = 0; i < 30; i++) out.push({ t, caller: "invoices", pair: (["EUR/USD", "GBP/USD", "USD/JPY"] as Pair[])[i % 3] });
    if (t >= 90 && t < 100) for (let i = 0; i < 4; i++) out.push({ t, caller: "export", pair: i % 2 ? "GBP/USD" : "EUR/USD" });
  }
  return out;
}

export const MOVE_AT = 30;
export const OUTAGE: [number, number] = [40, 55];

export function vendorRate(pair: Pair, t: number, b: Breaks): number {
  if (pair === "EUR/USD") return b.rateMove && t >= MOVE_AT ? 1.095 : 1.0812;
  return pair === "GBP/USD" ? 1.2645 : 151.2;
}

/* ---------------- one run ---------------- */

interface Answer { ok: boolean; value?: number; ms: number; via: string[]; denied?: boolean; hit?: boolean; err?: string }

export function simulate(chain: Layer[], ttl: Ttl, breaks: Breaks, n = 1): Run {
  const cache = new Map<Pair, { value: number; at: number }>();
  let connected = !chain.includes("lazy");
  const run: Run = {
    n, chain: [...chain], ttl, breaks: { ...breaks },
    vendorCalls: 0, vendorByCaller: { checkout: 0, invoices: 0, export: 0 },
    checkoutAvgMs: 0, stale: 0, errors: 0, denied: 0, unauthorized: 0,
    startupMs: connected ? CONNECT_MS : 0, traces: [],
  };

  const handle = (r: Request, i: number): Answer => {
    if (i === chain.length) {
      // the real subject: the vendor's client
      let ms = VENDOR_MS;
      const via = ["vendor"];
      if (!connected) { connected = true; ms += CONNECT_MS; via.unshift("connect"); }
      if (breaks.outage && r.t >= OUTAGE[0] && r.t < OUTAGE[1]) return { ok: false, ms: TIMEOUT_MS, via: [...via, "timeout"], err: "vendor timed out" };
      run.vendorCalls++;
      run.vendorByCaller[r.caller]++;
      return { ok: true, value: vendorRate(r.pair, r.t, breaks), ms, via };
    }
    const layer = chain[i];
    if (layer === "guard") {
      if (!SCOPED[r.caller]) return { ok: false, ms: 0, via: ["guard ✗"], denied: true, err: "denied: no rates:read scope" };
      const a = handle(r, i + 1);
      return { ...a, via: ["guard", ...a.via] };
    }
    if (layer === "cache") {
      const e = cache.get(r.pair);
      if (e && r.t - e.at < ttl) return { ok: true, value: e.value, ms: HIT_MS, via: ["cache hit"], hit: true };
      const a = handle(r, i + 1);
      if (a.ok && a.value !== undefined) cache.set(r.pair, { value: a.value, at: r.t });
      return { ...a, via: ["cache miss", ...a.via] };
    }
    // lazy: nothing to do per call; the connect happens at the vendor the first time
    const a = handle(r, i + 1);
    return { ...a, via: ["lazy", ...a.via] };
  };

  let checkoutMs = 0, checkoutN = 0;
  const seen = new Set<string>();
  let id = 0;
  for (const r of traffic()) {
    const a = handle(r, 0);
    const stale = a.ok && a.value !== vendorRate(r.pair, r.t, breaks);
    if (r.caller === "checkout") { checkoutMs += a.ms; checkoutN++; }
    if (a.denied) run.denied++;
    else if (!a.ok) run.errors++;
    if (stale) run.stale++;
    if (a.ok && !SCOPED[r.caller]) run.unauthorized++;

    // keep one sample of each kind of thing that happened, for the trace
    const kind = !a.ok ? (a.denied ? "denied" : "error") : stale ? "stale" : !SCOPED[r.caller] ? "leak" : a.hit ? "hit" : a.via.includes("connect") ? "first" : "call";
    if (!seen.has(kind)) {
      seen.add(kind);
      const when = `${Math.floor(r.t / 60)}:${String(r.t % 60).padStart(2, "0")}`;
      const text =
        kind === "denied" ? `${when} The export script asked for ${r.pair} and was refused. The vendor never saw it.`
        : kind === "error" ? `${when} The vendor is down. ${CALLER_NAME[r.caller]} waited ${TIMEOUT_MS} ms and got an error.`
        : kind === "stale" ? `${when} ${CALLER_NAME[r.caller]} got ${a.value} for ${r.pair}, but the vendor now says ${vendorRate(r.pair, r.t, breaks)}. A stale answer, served from the cache.`
        : kind === "leak" ? `${when} The export script has no rates:read scope, and still got ${r.pair} = ${a.value}${a.hit ? " straight from the cache" : ""}.`
        : kind === "hit" ? `${when} ${CALLER_NAME[r.caller]} asked for ${r.pair} again. Answered from memory in ${HIT_MS} ms; no vendor call.`
        : kind === "first" ? `${when} First call: the proxy opened the connection now, so this one call took ${a.ms} ms.`
        : `${when} ${CALLER_NAME[r.caller]} asked for ${r.pair}. One paid vendor call, ${a.ms} ms.`;
      run.traces.push({ id: id++, ok: a.ok && !stale && SCOPED[r.caller], text, path: [CALLER_NAME[r.caller], ...a.via, a.ok ? "✓" : "✗"] });
    }
  }
  run.checkoutAvgMs = Math.round(checkoutMs / checkoutN);
  return run;
}

/* ---------------- goals the reader can tick off ---------------- */

export interface Goals { cheap: boolean; outage: boolean; blocked: boolean; leak: boolean }
export function goals(runs: Run[]): Goals {
  return {
    cheap: runs.some((r) => r.vendorCalls < 20),
    outage: runs.some((r) => r.breaks.outage && r.errors === 0),
    blocked: runs.some((r) => r.vendorByCaller.export === 0 && r.unauthorized === 0),
    leak: runs.some((r) => r.chain.includes("guard") && r.unauthorized > 0),
  };
}

/* ---------------- step ---------------- */

const CANON: Record<Layer, number> = { guard: 0, cache: 1, lazy: 2 };

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "add": {
      if (st.chain.includes(a.layer)) return st;
      const chain = [...st.chain, a.layer].sort((x, y) => CANON[x] - CANON[y]);
      return { ...st, chain };
    }
    case "remove":
      return { ...st, chain: st.chain.filter((l) => l !== a.layer) };
    case "move": {
      const i = st.chain.indexOf(a.layer), j = i + a.dir;
      if (i < 0 || j < 0 || j >= st.chain.length) return st;
      const chain = [...st.chain];
      [chain[i], chain[j]] = [chain[j], chain[i]];
      return { ...st, chain };
    }
    case "ttl":
      return { ...st, ttl: a.ttl };
    case "break":
      return { ...st, breaks: { ...st.breaks, [a.kind]: !st.breaks[a.kind] } };
    case "run":
      return { ...st, runs: [...st.runs, simulate(st.chain, st.ttl, st.breaks, st.runs.length + 1)] };
  }
}
