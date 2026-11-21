// Page cache and readahead playground: a 1 MiB index file (256 pages of 4 KiB), the page cache
// and a disk. The reader reads pages one at a time, or runs a whole sequential pass, or the same
// 100 random lookups a search service answers after a restart.
//
// After this, the reader can answer: why does reading a whole file front to back cost only a
// handful of disk waits, while random lookups on a cold cache pay one disk wait each, and why is
// reading MORE data first (a sequential warm-up) faster than letting the lookups fetch what they
// need? (Readahead turns a sequential stream into a few large I/Os, and once a page is in the page
// cache every later read of it costs about a microsecond.)
//
// The readahead rules follow mm/readahead.c in simplified form: a miss at offset 0 or right after
// the previous read starts a window of 4 pages; the window grows x4 while small, then x2, capped
// at read_ahead_kb (128 KiB = 32 pages). The page that marks the async part of the window
// (PG_readahead) starts the next window in the background when it is read. A random miss reads
// only the page asked for. POSIX_FADV_RANDOM turns readahead off; O_DIRECT bypasses the cache.
//
// Plain state + a pure step function, so it can be tested without a browser. Times in µs.

export const PAGES = 256;
export const PAGE_KB = 4;
export const MAX_RA = 32; // read_ahead_kb = 128 -> 32 pages
export const HIT_US = 1; // a page cache hit: syscall plus a 4 KiB copy, about a microsecond
export const LOOKUPS = 100;

export type DeviceId = "nvme" | "network";
export const DEVICES: Record<DeviceId, { label: string; latency: number; perPage: number; note: string }> = {
  nvme: { label: "Local NVMe SSD", latency: 80, perPage: 2, note: "about 80 µs per I/O, 2 GB/s" },
  network: { label: "Network block volume", latency: 1000, perPage: 16, note: "about 1 ms per I/O, 250 MB/s" },
};

export interface Page { cached: boolean; readyAt: number; used: boolean; mark: boolean }

export interface Event {
  page: number;
  kind: "hit" | "wait" | "miss" | "direct";
  /** µs the read() call took */
  took: number;
  /** pages the disk I/O asked for, if one was issued synchronously */
  io?: [number, number];
  /** a background readahead started by this read */
  async?: [number, number];
}

export interface Counters { reads: number; hits: number; waits: number; ios: number; diskPages: number; waitedUs: number; tookUs: number }
const zero = (): Counters => ({ reads: 0, hits: 0, waits: 0, ios: 0, diskPages: 0, waitedUs: 0, tookUs: 0 });

export type RunKind = "sequential" | "lookups";
export interface Run {
  kind: RunKind;
  /** share of the file already cached when the run started, 0..1 */
  warmAtStart: number;
  readahead: boolean;
  direct: boolean;
  device: DeviceId;
  c: Counters;
}

export interface State {
  pages: Page[];
  now: number;
  /** the device works through I/Os one at a time */
  deviceFreeAt: number;
  ra: { start: number; size: number } | null;
  prev: number;
  readahead: boolean;
  direct: boolean;
  device: DeviceId;
  total: Counters;
  log: Event[];
  runs: Run[];
  /** the page the reader read last, for the cursor */
  cursor: number;
}

export type Action =
  | { type: "read"; page: number }
  | { type: "next" }
  | { type: "sequential" }
  | { type: "lookups" }
  | { type: "drop" }
  | { type: "readahead"; on: boolean }
  | { type: "direct"; on: boolean }
  | { type: "device"; device: DeviceId }
  | { type: "reset" };

const emptyPages = (): Page[] => Array.from({ length: PAGES }, () => ({ cached: false, readyAt: 0, used: false, mark: false }));

export function init(): State {
  return {
    pages: emptyPages(), now: 0, deviceFreeAt: 0, ra: null, prev: -1,
    readahead: true, direct: false, device: "nvme",
    total: zero(), log: [], runs: [], cursor: -1,
  };
}

/* ---------------- the same 100 lookups every time ---------------- */

function rand(seed: number) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pages 100 search queries read: random, with repeats, identical in every run so runs compare fairly. */
export const LOOKUP_PAGES: number[] = (() => {
  const r = rand(42);
  return Array.from({ length: LOOKUPS }, () => 1 + Math.floor(r() * (PAGES - 1)));
})();

/* ---------------- readahead window sizes (mm/readahead.c) ---------------- */

/** get_init_ra_size for a 1-page request: round up, x4 while small, x2 while medium. */
export function initWindow(req = 1): number {
  let n = 1;
  while (n < req) n *= 2;
  if (n <= MAX_RA / 32) return n * 4;
  if (n <= MAX_RA / 4) return n * 2;
  return MAX_RA;
}
/** get_next_ra_size: x4 while small, x2 up to half the max, then the max. */
export function nextWindow(cur: number): number {
  if (cur < MAX_RA / 16) return 4 * cur;
  if (cur <= MAX_RA / 2) return 2 * cur;
  return MAX_RA;
}

/* ---------------- one read() ---------------- */

/** Issue one disk I/O for the uncached pages in [from, to). Returns the time it completes, or null if nothing to read. */
function submit(st: State, c: Counters, from: number, to: number, start: number): number | null {
  const want: number[] = [];
  for (let i = from; i < Math.min(to, PAGES); i++) if (!st.pages[i].cached) want.push(i);
  if (!want.length) return null;
  const dev = DEVICES[st.device];
  const begin = Math.max(start, st.deviceFreeAt);
  const done = begin + dev.latency + dev.perPage * want.length;
  st.deviceFreeAt = done;
  for (const i of want) st.pages[i] = { ...st.pages[i], cached: true, readyAt: done };
  c.ios++;
  c.diskPages += want.length;
  return done;
}

/** Mutates a fresh copy (see `step`). */
function readPage(st: State, c: Counters, i: number): Event {
  const t0 = st.now;
  c.reads++;
  st.cursor = i;

  if (st.direct) {
    // O_DIRECT: straight to the device, one 4 KiB I/O, nothing kept in the cache.
    const dev = DEVICES[st.device];
    const begin = Math.max(st.now, st.deviceFreeAt);
    const done = begin + dev.latency + dev.perPage;
    st.deviceFreeAt = done;
    c.ios++; c.diskPages++; c.waits++;
    c.waitedUs += done - st.now;
    st.now = done + HIT_US;
    st.prev = i;
    const took = st.now - t0;
    c.tookUs += took;
    return { page: i, kind: "direct", took };
  }

  const p = st.pages[i];
  let ev: Event;
  if (p.cached) {
    let async: [number, number] | undefined;
    if (p.mark && st.ra) {
      // Hitting the PG_readahead page: start the next window in the background, then carry on.
      st.pages[i] = { ...st.pages[i], mark: false };
      const start = st.ra.start + st.ra.size;
      const size = nextWindow(st.ra.size);
      if (start < PAGES) {
        st.ra = { start, size };
        if (submit(st, c, start, start + size, st.now) !== null) {
          async = [start, Math.min(start + size, PAGES) - 1];
          st.pages[start] = { ...st.pages[start], mark: true };
        }
      }
    }
    const ready = st.pages[i].readyAt;
    if (ready > st.now) {
      c.waits++;
      c.waitedUs += ready - st.now;
      st.now = ready;
      ev = { page: i, kind: "wait", took: 0, async };
    } else {
      c.hits++;
      ev = { page: i, kind: "hit", took: 0, async };
    }
  } else {
    // A miss. Sequential (offset 0, or right after the previous read): open a readahead window.
    const sequential = st.readahead && (i === 0 || st.prev === i - 1);
    let size = 1;
    if (sequential) {
      size = st.ra && st.ra.start + st.ra.size === i ? nextWindow(st.ra.size) : initWindow(1);
      st.ra = { start: i, size };
    }
    const done = submit(st, c, i, i + size, st.now)!;
    if (sequential && size > 1) {
      // async_size = size - 1: the page after the one asked for carries the marker.
      const mark = i + 1;
      if (mark < PAGES && mark < i + size) st.pages[mark] = { ...st.pages[mark], mark: true };
    }
    c.waits++;
    c.waitedUs += done - st.now;
    st.now = done;
    ev = { page: i, kind: "miss", took: 0, io: [i, Math.min(i + size, PAGES) - 1] };
  }
  st.now += HIT_US;
  st.pages[i] = { ...st.pages[i], used: true };
  st.prev = i;
  ev.took = st.now - t0;
  c.tookUs += ev.took;
  return ev;
}

function fresh(st: State): State {
  return { ...st, pages: [...st.pages], total: { ...st.total }, log: [...st.log] };
}

export const cachedShare = (st: State) => st.pages.filter((p) => p.cached).length / PAGES;

function run(st: State, kind: RunKind, pages: number[]): State {
  const s = fresh(st);
  const c = zero();
  const warmAtStart = cachedShare(st);
  let last: Event | null = null;
  const events: Event[] = [];
  for (const i of pages) {
    last = readPage(s, c, i);
    events.push(last);
  }
  add(s.total, c);
  // Keep the log short: the interesting events of the run, newest first.
  const shown = events.filter((e) => e.kind !== "hit" || e.async).slice(-6).reverse();
  s.log = [...shown, ...s.log].slice(0, 8);
  s.runs = [...st.runs, { kind, warmAtStart, readahead: st.readahead, direct: st.direct, device: st.device, c }];
  return s;
}

function add(t: Counters, c: Counters) {
  for (const k of Object.keys(c) as (keyof Counters)[]) t[k] += c[k];
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "read":
    case "next": {
      const page = a.type === "read" ? a.page : (st.cursor + 1) % PAGES;
      if (page < 0 || page >= PAGES) return st;
      const s = fresh(st);
      const c = zero();
      const e = readPage(s, c, page);
      add(s.total, c);
      s.log = [e, ...s.log].slice(0, 8);
      return s;
    }
    case "sequential":
      return run(st, "sequential", Array.from({ length: PAGES }, (_, i) => i));
    case "lookups":
      return run(st, "lookups", LOOKUP_PAGES);
    case "drop":
      // echo 1 > /proc/sys/vm/drop_caches, or a fresh pod on a new node: the cache is empty.
      return { ...st, pages: emptyPages(), ra: null, prev: -1, cursor: -1, log: [] };
    case "readahead":
      return { ...st, readahead: a.on, ra: a.on ? st.ra : null, pages: a.on ? st.pages : st.pages.map((p) => (p.mark ? { ...p, mark: false } : p)) };
    case "direct":
      return { ...st, direct: a.on };
    case "device":
      return { ...st, device: a.device };
  }
}

/* ---------------- what the reader's runs show ---------------- */

export const isCold = (r: Run) => r.warmAtStart === 0;

/** Cold lookups on their own, and a cold sequential pass followed by the same lookups, on the same device. */
export function comparison(st: State): { device: DeviceId; coldLookups: Run; warmup: Run; warmLookups: Run } | null {
  const runs = st.runs.filter((r) => r.readahead && !r.direct);
  for (let i = runs.length - 1; i >= 1; i--) {
    const warmLookups = runs[i], warmup = runs[i - 1];
    if (warmLookups.kind !== "lookups" || warmup.kind !== "sequential" || !isCold(warmup) || warmLookups.device !== warmup.device) continue;
    if (st.runs.indexOf(warmLookups) !== st.runs.indexOf(warmup) + 1) continue;
    const coldLookups = [...runs].reverse().find((r) => r.kind === "lookups" && isCold(r) && r.device === warmup.device);
    if (coldLookups) return { device: warmup.device, coldLookups, warmup, warmLookups };
  }
  return null;
}

export interface Goals { coldLookups: boolean; warmBeatsCold: boolean; fewIos: boolean; noReadahead: boolean; directWarm: boolean }
export function goals(st: State): Goals {
  return {
    coldLookups: st.runs.some((r) => r.kind === "lookups" && isCold(r) && !r.direct),
    warmBeatsCold: (() => { const c = comparison(st); return !!c && c.warmup.c.tookUs + c.warmLookups.c.tookUs < c.coldLookups.c.tookUs; })(),
    fewIos: st.runs.some((r) => r.kind === "sequential" && isCold(r) && !r.direct && r.c.ios <= 12),
    noReadahead: st.runs.some((r) => r.kind === "sequential" && isCold(r) && !r.readahead && !r.direct),
    directWarm: st.runs.some((r) => r.direct && r.warmAtStart > 0.9),
  };
}
