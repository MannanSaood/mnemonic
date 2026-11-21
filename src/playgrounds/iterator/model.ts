// Iterator playground: a job walks every invoice in a billing API that returns 100 at a time.
// The same job runs two ways side by side: load every page into a list and then loop, or loop
// over an iterator that fetches the next page only when the loop asks for the next invoice.
// The reader can also pull the iterator one invoice at a time.
//
// After this, the reader can answer: "Both versions are a for loop over invoices, so why does
// one make 200 API calls and hold 40 MB when the other makes 3 calls and holds one page?"
// Core insight: an iterator hands out one element at a time when the consumer asks, so the
// producer only does the work the consumer actually needs: fetching stops when the loop stops,
// and memory holds one page, not the whole collection. The paging hides inside the iterator,
// so the iterator must page correctly (cursor, not offset) when data changes underneath it.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Job = "first-big" | "first-20" | "export";
export type Paging = "offset" | "cursor";
export type Design = "eager" | "lazy";

export const JOBS: Record<Job, { label: string; what: string }> = {
  "first-big": { label: "Find the first invoice over $5,000", what: "stops at the first match" },
  "first-20": { label: "Show the latest 20 on the dashboard", what: "stops after 20" },
  export: { label: "Export every invoice to CSV", what: "reads everything" },
};
export const TOTALS = [2_000, 20_000, 200_000] as const;
export const PAGE_SIZES = [25, 100, 500] as const;
/** Index (0-based) of the first invoice over $5,000. */
export const BIG_AT = 237;
export const LATENCY_MS = 150;
export const ROW_KB = 2;
/** The worker's memory limit; going over it kills the process. */
export const LIMIT_MB = 256;
/** With "new invoices arrive", this many land at the top of the list between two page fetches. */
export const INSERTS_PER_FETCH = 3;
export const FAIL_PAGE = 5;

export interface Run {
  calls: number;
  peakMb: number;
  /** ms until the loop body sees its first invoice */
  firstMs: number | null;
  totalMs: number;
  processed: number;
  duplicates: number;
  outcome: "done" | "oom" | "failed";
  /** Pages that were in memory at the end, for the page strip. */
  held: number;
  /** Page number to resume from after a failure, when the design can resume. */
  resumeAt: number | null;
}

export interface Pull {
  /** Invoices handed to the loop so far. */
  index: number;
  pagesFetched: number;
  current: number | null;
  done: boolean;
}

export interface State {
  job: Job;
  total: (typeof TOTALS)[number];
  pageSize: (typeof PAGE_SIZES)[number];
  failing: boolean;
  inserts: boolean;
  paging: Paging;
  runs: { eager: Run; lazy: Run; job: Job; total: number; pageSize: number; inserts: boolean; paging: Paging; failing: boolean } | null;
  pull: Pull;
  prediction: string | null;
  flags: { firstBig20k: boolean; oom: boolean; failSaved: boolean; dupes: boolean; cursorClean: boolean };
}

export type Action =
  | { type: "setJob"; job: Job }
  | { type: "setTotal"; total: (typeof TOTALS)[number] }
  | { type: "setPageSize"; size: (typeof PAGE_SIZES)[number] }
  | { type: "setFailing"; on: boolean }
  | { type: "setInserts"; on: boolean }
  | { type: "setPaging"; paging: Paging }
  | { type: "run" }
  | { type: "pull" }
  | { type: "predict"; value: string }
  | { type: "reset" };

const freshPull = (): Pull => ({ index: 0, pagesFetched: 0, current: null, done: false });

export function init(): State {
  return {
    job: "first-big", total: 20_000, pageSize: 100, failing: false, inserts: false, paging: "offset",
    runs: null, pull: freshPull(), prediction: null,
    flags: { firstBig20k: false, oom: false, failSaved: false, dupes: false, cursorClean: false },
  };
}

/** Invoice amount by position: deterministic, with exactly one big one early on. */
export function amount(i: number): number {
  return i === BIG_AT ? 5_840 : 120 + ((i * 7919) % 4_600);
}

export const pages = (total: number, size: number) => Math.ceil(total / size);

/** How many invoices the job needs before it can stop. */
export function needed(job: Job, total: number): number {
  return job === "first-big" ? Math.min(BIG_AT + 1, total) : job === "first-20" ? Math.min(20, total) : total;
}

const mb = (rows: number) => Math.round(((rows * ROW_KB) / 1024) * 10) / 10;

/** Duplicates seen when paging by offset while new rows arrive at the top. */
function dupes(s: Pick<State, "inserts" | "paging">, pagesFetched: number): number {
  return s.inserts && s.paging === "offset" ? INSERTS_PER_FETCH * Math.max(0, pagesFetched - 1) : 0;
}

export function simulate(s: Pick<State, "job" | "total" | "pageSize" | "failing" | "inserts" | "paging">, d: Design): Run {
  const all = pages(s.total, s.pageSize);
  const need = needed(s.job, s.total);
  const failAt = s.failing && FAIL_PAGE <= all ? FAIL_PAGE : null;

  if (d === "eager") {
    // Fetch every page first, keeping them all, then loop.
    const fetchUntil = failAt ?? all;
    const rowsHeld = Math.min(s.total, fetchUntil * s.pageSize) + dupes(s, fetchUntil);
    const peakMb = mb(rowsHeld);
    if (failAt) return { calls: failAt, peakMb: mb((failAt - 1) * s.pageSize), firstMs: null, totalMs: failAt * LATENCY_MS, processed: 0, duplicates: 0, outcome: "failed", held: failAt - 1, resumeAt: null };
    if (peakMb > LIMIT_MB) {
      const oomPage = Math.ceil(((LIMIT_MB * 1024) / ROW_KB) / s.pageSize);
      return { calls: oomPage, peakMb: LIMIT_MB, firstMs: null, totalMs: oomPage * LATENCY_MS, processed: 0, duplicates: 0, outcome: "oom", held: oomPage, resumeAt: null };
    }
    const fetchMs = all * LATENCY_MS;
    return { calls: all, peakMb, firstMs: fetchMs, totalMs: fetchMs, processed: need, duplicates: dupes(s, all), outcome: "done", held: all, resumeAt: null };
  }

  // Lazy: fetch the next page only when the loop needs an invoice from it.
  const needPages = pages(need, s.pageSize);
  if (failAt && failAt <= needPages) {
    const processed = (failAt - 1) * s.pageSize;
    return { calls: failAt, peakMb: mb(s.pageSize), firstMs: LATENCY_MS, totalMs: failAt * LATENCY_MS, processed, duplicates: dupes(s, failAt - 1), outcome: "failed", held: 1, resumeAt: failAt };
  }
  return { calls: needPages, peakMb: mb(s.pageSize), firstMs: LATENCY_MS, totalMs: needPages * LATENCY_MS, processed: need, duplicates: dupes(s, needPages), outcome: "done", held: 1, resumeAt: null };
}

function pullOne(s: State): Pull {
  const p = s.pull;
  const need = needed(s.job, s.total);
  if (p.done) return p;
  if (p.index >= need) return { ...p, done: true, current: null };
  const pageOfNext = Math.floor(p.index / s.pageSize) + 1;
  return { index: p.index + 1, pagesFetched: Math.max(p.pagesFetched, pageOfNext), current: p.index, done: false };
}

/** Settings changed: earlier results no longer match, so clear them. */
const settings = (s: State, patch: Partial<State>): State => ({ ...s, ...patch, runs: null, pull: freshPull() });

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return s.prediction ? s : { ...s, prediction: a.value };
    case "setJob": return settings(s, { job: a.job });
    case "setTotal": return settings(s, { total: a.total });
    case "setPageSize": return settings(s, { pageSize: a.size });
    case "setFailing": return settings(s, { failing: a.on });
    case "setInserts": return settings(s, { inserts: a.on });
    case "setPaging": return settings(s, { paging: a.paging });
    case "pull": return { ...s, pull: pullOne(s) };
    case "run": {
      const eager = simulate(s, "eager"), lazy = simulate(s, "lazy");
      const f = { ...s.flags };
      if (s.job === "first-big" && s.total === 20_000 && !s.failing) f.firstBig20k = true;
      if (eager.outcome === "oom") f.oom = true;
      if (s.failing && s.job === "export" && lazy.processed > eager.processed) f.failSaved = true;
      if (s.job === "export" && s.inserts && s.paging === "offset" && lazy.duplicates > 0) f.dupes = true;
      if (s.job === "export" && s.inserts && s.paging === "cursor" && lazy.outcome === "done") f.cursorClean = true;
      return { ...s, flags: f, runs: { eager, lazy, job: s.job, total: s.total, pageSize: s.pageSize, inserts: s.inserts, paging: s.paging, failing: s.failing } };
    }
  }
}

export const CHALLENGES = [
  { id: "firstBig20k", text: "Find the first invoice over $5,000 in 20,000. Compare the API calls." },
  { id: "oom", text: "Export 200,000 invoices. Which design survives?" },
  { id: "failSaved", text: "Make page 5 fail during an export. How many rows did each design get through?" },
  { id: "dupes", text: "Let new invoices arrive during an export with offset paging. Count the duplicates." },
  { id: "cursorClean", text: "Do the same export with cursor paging." },
] as const;

export const challengeDone = (s: State, id: (typeof CHALLENGES)[number]["id"]) => s.flags[id];
