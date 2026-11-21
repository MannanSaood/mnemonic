// Singleton playground: run a pricing service's test suite against one global config.
//
// After this, the reader can answer: why does a global instance make tests depend on each
// other's order and timing, why does resetting it in teardown only fix the order, and what
// changes when the one instance is created in main and passed in?
//
// Part A, the suite. Six tests each pass when run alone. They read and write a config object:
// region, a feature flag and the database pool. With a global singleton they all share one
// object; with injection each test builds its own. The reader picks how many workers run the
// suite in parallel, whether tests reset the global in teardown, and runs it repeatedly with
// different (seeded) orders. A Gantt chart shows when each test ran and who broke whom.
//
// Part B, the honest singleton. Some things really should exist once per process: a
// connection pool. Three requests arrive at a cold start. A naive "if nil then create" check
// can create several pools; a once-guard (sync.Once, OnceLock, module import) creates one.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Design = "global" | "injected";
export type Key = "region" | "newPricing" | "pool";
export const DEFAULTS: Record<Key, string> = { region: "us", newPricing: "off", pool: "test-db" };

export interface TestSpec {
  id: string;
  name: string;
  writes: Partial<Record<Key, string>>;
  /** Reads happen at this tick after the test starts, and must see the expected value. */
  readAt: number;
  expect: Partial<Record<Key, string>>;
  duration: number;
}

export const TESTS: TestSpec[] = [
  { id: "eu", name: "EU checkout adds VAT", writes: { region: "eu" }, readAt: 2, expect: { region: "eu" }, duration: 3 },
  { id: "us", name: "US checkout adds sales tax", writes: { region: "us" }, readAt: 1, expect: { region: "us" }, duration: 2 },
  { id: "flag", name: "new pricing gives 10% off", writes: { newPricing: "on" }, readAt: 2, expect: { newPricing: "on" }, duration: 3 },
  { id: "default", name: "default pricing is list price", writes: {}, readAt: 1, expect: { newPricing: "off" }, duration: 2 },
  { id: "fake", name: "refund is recorded (fake DB)", writes: { pool: "fake" }, readAt: 1, expect: { pool: "fake" }, duration: 2 },
  { id: "report", name: "daily report sums the test DB", writes: {}, readAt: 2, expect: { pool: "test-db" }, duration: 3 },
];

export interface Slot { test: string; worker: number; start: number; end: number; ok: boolean; why: string; blame: string | null }
export interface SuiteRun { design: Design; workers: number; teardown: boolean; seed: number; slots: Slot[]; failed: string[] }

export type ColdMode = "naive" | "once";
export interface ColdStart { mode: ColdMode; seed: number; checks: number[]; pools: number }

export interface State {
  design: Design;
  workers: number;
  teardown: boolean;
  seed: number;
  prediction: "none" | "some" | "all" | null;
  last: SuiteRun | null;
  /** All runs with the current settings, to count flaky tests. */
  history: SuiteRun[];
  cold: ColdStart | null;
  coldMode: ColdMode;
  coldSeed: number;
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "workers"; n: number }
  | { type: "teardown" }
  | { type: "predict"; value: "none" | "some" | "all" }
  | { type: "run" }
  | { type: "runMany"; times: number }
  | { type: "coldMode"; mode: ColdMode }
  | { type: "coldStart" }
  | { type: "reset" };

export function init(): State {
  return { design: "global", workers: 1, teardown: false, seed: 1, prediction: null, last: null, history: [], cold: null, coldMode: "naive", coldSeed: 1 };
}

/* ---------------- deterministic randomness ---------------- */

function rand(seed: number) {
  let t = seed * 2654435761 + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function order(seed: number): TestSpec[] {
  const r = rand(seed);
  const xs = [...TESTS];
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/* ---------------- running the suite ---------------- */

export function runSuite(design: Design, workers: number, teardown: boolean, seed: number): SuiteRun {
  const tests = order(seed);
  const free = Array.from({ length: workers }, () => 0);
  const placed = tests.map((t) => {
    let w = 0;
    for (let i = 1; i < free.length; i++) if (free[i] < free[w]) w = i;
    const start = free[w];
    free[w] = start + t.duration;
    return { t, worker: w, start, end: start + t.duration };
  });

  // The global config and who wrote each key last.
  const global: Record<Key, string> = { ...DEFAULTS };
  const writer: Record<Key, string | null> = { region: null, newPricing: null, pool: null };
  const result = new Map<string, { ok: boolean; why: string; blame: string | null }>();
  const horizon = Math.max(...placed.map((p) => p.end));

  for (let tick = 0; tick <= horizon; tick++) {
    // 1. Tests that end now tear down (restore defaults for what they wrote).
    if (teardown)
      for (const p of placed.filter((x) => x.end === tick))
        for (const k of Object.keys(p.t.writes) as Key[]) { global[k] = DEFAULTS[k]; writer[k] = null; }
    // 2. Tests that start now set up.
    for (const p of placed.filter((x) => x.start === tick))
      for (const [k, v] of Object.entries(p.t.writes) as [Key, string][]) { global[k] = v; writer[k] = p.t.id; }
    // 3. Tests read and assert.
    for (const p of placed.filter((x) => x.start + x.t.readAt === tick)) {
      if (design === "injected") { result.set(p.t.id, { ok: true, why: "Its own config, built in the test.", blame: null }); continue; }
      const bad = (Object.entries(p.t.expect) as [Key, string][]).find(([k, v]) => global[k] !== v);
      if (!bad) { result.set(p.t.id, { ok: true, why: "Saw what it expected.", blame: null }); continue; }
      const [k, v] = bad;
      const by = writer[k];
      result.set(p.t.id, { ok: false, why: `expected ${k}=${v}, got ${global[k]}`, blame: by && by !== p.t.id ? by : null });
    }
  }
  const slots: Slot[] = placed.map((p) => ({ test: p.t.id, worker: p.worker, start: p.start, end: p.end, ...result.get(p.t.id)! }));
  return { design, workers, teardown, seed, slots, failed: slots.filter((s) => !s.ok).map((s) => s.test) };
}

/** Tests that failed in some runs and passed in others: flaky. */
export function flaky(history: SuiteRun[]): string[] {
  return TESTS.map((t) => t.id).filter((id) => {
    const f = history.filter((h) => h.failed.includes(id)).length;
    return f > 0 && f < history.length;
  });
}
/** Tests that failed in every run. */
export function alwaysFail(history: SuiteRun[]): string[] {
  return history.length ? TESTS.map((t) => t.id).filter((id) => history.every((h) => h.failed.includes(id))) : [];
}

/* ---------------- cold start ---------------- */

/**
 * Three requests arrive together. Each checks "is there a pool?" at some tick 0..2 and, if it
 * saw none, creates one, which takes 2 ticks. A once-guard makes the other two wait.
 */
export function coldStart(mode: ColdMode, seed: number): ColdStart {
  const r = rand(1000 + seed);
  const checks = [0, 1, 2].map(() => Math.floor(r() * 3));
  if (mode === "once") return { mode, seed, checks, pools: 1 };
  const firstReady = Math.min(...checks) + 2;
  const pools = checks.filter((c) => c < firstReady).length;
  return { mode, seed, checks, pools };
}

/* ---------------- step ---------------- */

const settingsChanged = (st: State): State => ({ ...st, history: [], last: null });

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "design":
      return settingsChanged({ ...st, design: a.design });
    case "workers":
      return settingsChanged({ ...st, workers: Math.max(1, Math.min(4, Math.round(a.n))) });
    case "teardown":
      return settingsChanged({ ...st, teardown: !st.teardown });
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "run": {
      const last = runSuite(st.design, st.workers, st.teardown, st.seed);
      return { ...st, last, history: [...st.history, last], seed: st.seed + 1 };
    }
    case "runMany": {
      let s = st;
      for (let i = 0; i < a.times; i++) s = step(s, { type: "run" });
      return s;
    }
    case "coldMode":
      return { ...st, coldMode: a.mode, cold: null };
    case "coldStart":
      return { ...st, cold: coldStart(st.coldMode, st.coldSeed), coldSeed: st.coldSeed + 1 };
  }
}
