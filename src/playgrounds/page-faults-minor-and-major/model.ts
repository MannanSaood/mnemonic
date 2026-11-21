// Page-fault arena: a search service maps its index file and keeps a small heap.
//
// After this, the reader can answer: when a memory access traps into the kernel, what decides
// whether it costs a microsecond or a millisecond? (Whether the page is already in RAM, in the
// page cache or as a shared copy-on-write page, or must be read from disk.) And why does the
// first write after fork() fault even though the page is in RAM?
//
// The arena has one process's virtual pages (six pages of a MAP_SHARED read-only mapping of
// index.bin, four heap pages, two unmapped), physical frames (frame 0 is the shared zero page)
// and the file on disk. Touching a page (read or write) resolves exactly as the kernel would:
// no fault, minor fault (page cache hit, zero page, zero-fill, copy-on-write, or reuse), major
// fault (disk read), or SIGSEGV. A request touches a fixed set of pages and reports its latency.
// Break-it: memory pressure evicts the clean file pages. Fix: prefault the mapping
// (MAP_POPULATE). Then fork and write to watch copy-on-write.
//
// Latencies are a model: no fault 0.1 µs, minor fault about 1 µs, a read from a cloud block
// volume 1 ms. Plain state + a pure step function, so it can be tested without a browser.

export const FILE_PAGES = 6; // vpages 0..5 map index.bin pages 0..5
export const HEAP = [6, 7, 8, 9];
export const VPAGES = 12; // 10 and 11 are not mapped at all
export const FRAMES = 16; // frame 0 is the zero page
export const ZERO = 0;

export const LAT = { hit: 0.1, cacheMap: 0.5, zeroMap: 0.4, zeroFill: 1, cow: 1.5, reuse: 0.5, major: 1000 } as const; // µs

export type Pid = "parent" | "child";
export type Mode = "read" | "write";
export type Kind = "none" | "minor" | "major" | "segv";
export type Why = "hit" | "cache" | "zero-page" | "zero-fill" | "cow" | "reuse" | "disk" | "read-only" | "no-vma";

export interface Pte { frame: number; writable: boolean }
export interface Frame { content: { file: number } | { anon: number } | "zero" | null; refs: number }

export interface Touch { pid: Pid; vpage: number; mode: Mode; kind: Kind; why: Why; us: number; path: string[] }
export interface RequestRun { n: number; pid: Pid; us: number; minor: number; major: number; populated: boolean }

export interface Counters { minor: number; major: number; cow: number; us: number }

export interface State {
  mode: Mode;
  pid: Pid;
  forked: boolean;
  populated: boolean;
  tables: Record<Pid, Record<number, Pte>>;
  frames: Frame[];
  /** index.bin page -> frame holding it in the page cache. */
  cache: Record<number, number>;
  counters: Record<Pid, Counters>;
  last: Touch | null;
  log: (Touch & { id: number })[];
  nextId: number;
  requests: RequestRun[];
  /** Disk time paid at startup by prefaulting, outside any request (µs). */
  startupUs: number;
  prediction: "none" | "micro" | "milli" | null;
}

export type Action =
  | { type: "mode"; mode: Mode }
  | { type: "touch"; vpage: number }
  | { type: "request" }
  | { type: "populate" }
  | { type: "pressure" }
  | { type: "fork" }
  | { type: "pid"; pid: Pid }
  | { type: "predict"; value: "none" | "micro" | "milli" }
  | { type: "reset" };

/** What one request does: read four index pages, write one heap page. */
export const REQUEST: { vpage: number; mode: Mode }[] = [
  { vpage: 0, mode: "read" }, { vpage: 2, mode: "read" }, { vpage: 4, mode: "read" }, { vpage: 5, mode: "read" }, { vpage: 6, mode: "write" },
];

const zero = (): Counters => ({ minor: 0, major: 0, cow: 0, us: 0 });

export function init(): State {
  const frames: Frame[] = Array.from({ length: FRAMES }, () => ({ content: null, refs: 0 }));
  frames[ZERO] = { content: "zero", refs: 0 };
  // A nightly backup read index.bin page 2 a little while ago, so it is still in the page cache.
  frames[1] = { content: { file: 2 }, refs: 0 };
  return {
    mode: "read", pid: "parent", forked: false, populated: false,
    tables: { parent: {}, child: {} },
    frames, cache: { 2: 1 },
    counters: { parent: zero(), child: zero() },
    last: null, log: [], nextId: 1, requests: [], startupUs: 0, prediction: null,
  };
}

export const isFile = (v: number) => v >= 0 && v < FILE_PAGES;
export const isHeap = (v: number) => HEAP.includes(v);

function freeFrame(frames: Frame[]): number {
  const i = frames.findIndex((f, j) => j !== ZERO && f.content === null);
  if (i < 0) throw new Error("out of frames"); // cannot happen with 16 frames and this layout
  return i;
}

/** Resolve one access in process `pid`, exactly as the fault handler would. Pure. */
export function access(st: State, pid: Pid, vpage: number, mode: Mode): { st: State; touch: Touch } {
  const table = { ...st.tables[pid] };
  const frames = st.frames.map((f) => ({ ...f }));
  const cache = { ...st.cache };
  const pte = table[vpage];
  let kind: Kind, why: Why, us: number, path: string[];

  if (!isFile(vpage) && !isHeap(vpage)) {
    kind = "segv"; why = "no-vma"; us = 0;
    path = [`p${vpage}`, "no VMA", "SIGSEGV"];
  } else if (isFile(vpage) && mode === "write") {
    kind = "segv"; why = "read-only"; us = 0;
    path = [`p${vpage}`, "VMA is read-only", "SIGSEGV"];
  } else if (pte && (mode === "read" || pte.writable)) {
    kind = "none"; why = "hit"; us = LAT.hit;
    path = [`p${vpage}`, "PTE present", "load"];
  } else if (pte && mode === "write") {
    // Present but read-only in a writable VMA: the zero page or a copy-on-write page.
    const old = frames[pte.frame];
    if (pte.frame === ZERO) {
      const f = freeFrame(frames);
      frames[f] = { content: { anon: vpage }, refs: 1 };
      table[vpage] = { frame: f, writable: true };
      kind = "minor"; why = "zero-fill"; us = LAT.zeroFill;
      path = [`p${vpage}`, "write to zero page", "new frame, zeroed", "map rw"];
    } else if (old.refs > 1) {
      const f = freeFrame(frames);
      frames[f] = { content: old.content, refs: 1 };
      old.refs -= 1;
      table[vpage] = { frame: f, writable: true };
      kind = "minor"; why = "cow"; us = LAT.cow;
      path = [`p${vpage}`, "write to shared page", "copy 4 KiB", "map rw"];
    } else {
      table[vpage] = { frame: pte.frame, writable: true };
      kind = "minor"; why = "reuse"; us = LAT.reuse;
      path = [`p${vpage}`, "write to COW page", "last user: no copy", "map rw"];
    }
  } else if (isHeap(vpage)) {
    if (mode === "read") {
      frames[ZERO].refs += 1;
      table[vpage] = { frame: ZERO, writable: false };
      kind = "minor"; why = "zero-page"; us = LAT.zeroMap;
      path = [`p${vpage}`, "PTE empty", "map the zero page"];
    } else {
      const f = freeFrame(frames);
      frames[f] = { content: { anon: vpage }, refs: 1 };
      table[vpage] = { frame: f, writable: true };
      kind = "minor"; why = "zero-fill"; us = LAT.zeroFill;
      path = [`p${vpage}`, "PTE empty", "new frame, zeroed", "map rw"];
    }
  } else if (cache[vpage] !== undefined) {
    const f = cache[vpage];
    frames[f].refs += 1;
    table[vpage] = { frame: f, writable: false };
    kind = "minor"; why = "cache"; us = LAT.cacheMap;
    path = [`p${vpage}`, "PTE empty", "page cache hit", "map"];
  } else {
    const f = freeFrame(frames);
    frames[f] = { content: { file: vpage }, refs: 1 };
    cache[vpage] = f;
    table[vpage] = { frame: f, writable: false };
    kind = "major"; why = "disk"; us = LAT.major + LAT.cacheMap;
    path = [`p${vpage}`, "PTE empty", "page cache miss", "read from disk", "map"];
  }

  const c = { ...st.counters[pid] };
  if (kind === "minor") c.minor += 1;
  if (kind === "major") c.major += 1;
  if (why === "cow") c.cow += 1;
  c.us += us;
  const touch: Touch = { pid, vpage, mode, kind, why, us, path };
  return {
    st: { ...st, tables: { ...st.tables, [pid]: table }, frames, cache, counters: { ...st.counters, [pid]: c } },
    touch,
  };
}

function logged(st: State, t: Touch): State {
  return { ...st, last: t, log: [{ ...t, id: st.nextId }, ...st.log].slice(0, 6), nextId: st.nextId + 1 };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "mode":
      return { ...st, mode: a.mode };
    case "pid":
      return st.forked ? { ...st, pid: a.pid } : st;
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "touch": {
      const { st: s, touch } = access(st, st.pid, a.vpage, st.mode);
      return logged(s, touch);
    }
    case "request": {
      let s = st;
      let us = 0, minor = 0, major = 0;
      for (const r of REQUEST) {
        const out = access(s, st.pid, r.vpage, r.mode);
        s = out.st;
        us += out.touch.us;
        if (out.touch.kind === "minor") minor++;
        if (out.touch.kind === "major") major++;
      }
      const run: RequestRun = { n: st.requests.length + 1, pid: st.pid, us, minor, major, populated: st.populated };
      return { ...s, requests: [...st.requests, run].slice(-8), last: null };
    }
    case "populate": {
      // MAP_POPULATE at startup: read every index page into the page cache and map it now,
      // before the service takes traffic. The disk time is paid here, outside any request.
      let s = st;
      let us = 0;
      for (let v = 0; v < FILE_PAGES; v++) if (!s.tables[st.pid][v]) {
        const out = access(s, st.pid, v, "read");
        s = out.st;
        us += out.touch.us;
      }
      return { ...s, counters: st.counters, populated: true, startupUs: st.startupUs + us, last: null };
    }
    case "pressure": {
      // Reclaim: clean file pages can be dropped at any time (they can be read again), so the
      // kernel unmaps them from every process and frees the frames. Anonymous pages would need
      // swap, which this host does not have.
      const frames = st.frames.map((f) => ({ ...f }));
      const tables: Record<Pid, Record<number, Pte>> = { parent: { ...st.tables.parent }, child: { ...st.tables.child } };
      for (const [page, f] of Object.entries(st.cache)) {
        frames[f] = { content: null, refs: 0 };
        for (const p of ["parent", "child"] as Pid[]) delete tables[p][Number(page)];
      }
      return { ...st, frames, tables, cache: {}, populated: false, last: null };
    }
    case "fork": {
      if (st.forked) return st;
      // The child gets a copy of the page table for private memory, not of the pages: private
      // writable pages become read-only in both, and each frame now has two users. Entries for a
      // shared file mapping are not copied at all; the child refaults them cheaply from the
      // page cache when it touches them.
      const frames = st.frames.map((f) => ({ ...f }));
      const parent: Record<number, Pte> = {};
      const child: Record<number, Pte> = {};
      for (const [k, pte] of Object.entries(st.tables.parent)) {
        const v = Number(k);
        if (!isHeap(v)) { parent[v] = pte; continue; }
        frames[pte.frame].refs += 1;
        parent[v] = { frame: pte.frame, writable: false };
        child[v] = { frame: pte.frame, writable: false };
      }
      return { ...st, frames, forked: true, tables: { parent, child }, pid: "child", last: null };
    }
  }
}

/** Pages of RAM a process maps (its resident set, in pages; the zero page does not count). */
export const rss = (st: State, pid: Pid) => Object.values(st.tables[pid]).filter((p) => p.frame !== ZERO).length;
export const cachedPages = (st: State) => Object.keys(st.cache).length;
export const usedFrames = (st: State) => st.frames.filter((f, i) => i !== ZERO && f.content !== null).length;

/** The first request served without prefaulting, and the best later one, for the result line. */
export function requestSummary(runs: RequestRun[]): { cold: RequestRun; warm: RequestRun } | null {
  const cold = runs.find((r) => r.major > 0);
  const warm = runs.filter((r) => r.major === 0).sort((a, b) => a.us - b.us)[0];
  return cold && warm ? { cold, warm } : null;
}
