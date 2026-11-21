// Memory cgroup playground: one container with memory.max = 1 GiB, three processes and the page
// cache charged to it. The reader grows anonymous memory (the heap) and page cache, and watches
// reclaim, swap, memory.high throttling and the OOM kill, with the real memory.events counters.
//
// After this, the reader can answer: when a container reaches its memory limit, what does the
// kernel take back first, and who gets killed when that is not enough? (Clean page cache goes
// first, so a shrinking cache is normal, not a leak. Then anonymous memory goes to swap if the
// group may swap. Only when nothing more can be reclaimed does the OOM killer run, and it picks the
// process with the most memory plus its oom_score_adj, not the one that asked.)
//
// Rules follow Documentation/admin-guide/cgroup-v2.rst and mm/oom_kill.c, simplified: usage
// (memory.current) = kernel + anon + file; reclaim takes cold file pages, then hot file pages, then
// swaps anon out while memory.swap.max allows; badness = resident + swapped memory +
// oom_score_adj * limit / 1000, the highest is killed. memory.high reclaims and throttles the
// allocating task but never kills. Units are MiB. Plain state + pure step function, tested.

export const LIMIT = 1024;     // memory.max
export const HIGH = 896;       // memory.high when the reader turns it on
export const KERNEL = 24;      // slab, page tables, socket buffers: charged, not reclaimable here
export const SWAP_MAX = 256;   // memory.swap.max when the reader allows swap
export const STEP = 64;        // one allocation
export const READ = 128;       // one file read

export type ProcId = "api" | "worker" | "shipper";
export const PROCS: ProcId[] = ["api", "worker", "shipper"];
export const PROC_INFO: Record<ProcId, { name: string; role: string }> = {
  api: { name: "api", role: "the service, PID 1 of the container" },
  worker: { name: "worker", role: "a report job started by the API" },
  shipper: { name: "log-shipper", role: "tails and ships log files" },
};

export interface Proc { anon: number; swapped: number; adj: number; alive: boolean; exit: number | null }

export interface Events { low: number; high: number; max: number; oom: number; oom_kill: number }

export type LogKind = "alloc" | "reclaim" | "swap" | "throttle" | "oom" | "kill" | "read" | "fail";
export interface Log { kind: LogKind; text: string }

export interface State {
  procs: Record<ProcId, Proc>;
  /** page cache charged to the group: hot = in active use (the API's binary and data files), cold = read once */
  hot: number;
  cold: number;
  swapOn: boolean;
  highOn: boolean;
  events: Events;
  /** totals the reader's result is built from */
  reclaimedFile: number;
  hotEvicted: number;
  swappedOut: number;
  throttledMs: number;
  cacheAtFirstKill: number | null;
  /** the first kill: who asked, and who died */
  firstKill: { asked: ProcId; victim: ProcId; scores: Record<ProcId, number> } | null;
  kills: { asked: ProcId; victim: ProcId }[];
  log: Log[];
  /** the cache size when the reader started, for the result */
  startCache: number;
  /** challenges met so far; kept across container restarts */
  found: Goals;
}

export type Action =
  | { type: "alloc"; proc: ProcId }
  | { type: "free"; proc: ProcId }
  | { type: "read" }
  | { type: "adj"; proc: ProcId; adj: number }
  | { type: "swap"; on: boolean }
  | { type: "high"; on: boolean }
  | { type: "restart" }
  | { type: "reset" };

const zeroEvents = (): Events => ({ low: 0, high: 0, max: 0, oom: 0, oom_kill: 0 });

function freshProcs(adj?: Partial<Record<ProcId, number>>): Record<ProcId, Proc> {
  return {
    api: { anon: 280, swapped: 0, adj: adj?.api ?? 0, alive: true, exit: null },
    worker: { anon: 96, swapped: 0, adj: adj?.worker ?? 0, alive: true, exit: null },
    shipper: { anon: 40, swapped: 0, adj: adj?.shipper ?? 0, alive: true, exit: null },
  };
}

export function init(): State {
  return {
    procs: freshProcs(), hot: 80, cold: 300, swapOn: false, highOn: false, events: zeroEvents(),
    reclaimedFile: 0, hotEvicted: 0, swappedOut: 0, throttledMs: 0, cacheAtFirstKill: null, firstKill: null, kills: [],
    log: [], startCache: 380,
    found: { cacheFirst: false, notTheAsker: false, steered: false, throttled: false, swapSaved: false },
  };
}

/* ---------------- accounting ---------------- */

export const anonTotal = (st: State) => PROCS.reduce((a, p) => a + (st.procs[p].alive ? st.procs[p].anon : 0), 0);
export const swapTotal = (st: State) => PROCS.reduce((a, p) => a + (st.procs[p].alive ? st.procs[p].swapped : 0), 0);
/** memory.current */
export const usage = (st: State) => KERNEL + anonTotal(st) + st.hot + st.cold;
export const swapMax = (st: State) => (st.swapOn ? SWAP_MAX : 0);

/** oom_badness, in MiB: resident + swapped memory, plus oom_score_adj per mille of the limit. */
export function badness(st: State, p: ProcId): number {
  const x = st.procs[p];
  if (!x.alive || x.adj <= -1000) return -Infinity;
  return x.anon + x.swapped + (x.adj * LIMIT) / 1000;
}
/** The 0..1000 score a reader would compare: badness as a share of the limit (the kernel scales it into /proc/<pid>/oom_score). */
export const score = (st: State, p: ProcId) => {
  const b = badness(st, p);
  return b === -Infinity ? 0 : Math.max(0, Math.min(1000, Math.round((b * 1000) / LIMIT)));
};

/* ---------------- reclaim ---------------- */

/** Reclaim up to `need` MiB: cold cache, then hot cache, then swap anon out. Returns what it freed. Mutates. */
function reclaim(st: State, need: number, log: Log[]): number {
  let freed = 0;
  const cold = Math.min(st.cold, need);
  if (cold > 0) { st.cold -= cold; freed += cold; st.reclaimedFile += cold; }
  const hot = Math.min(st.hot, need - freed);
  if (hot > 0) { st.hot -= hot; freed += hot; st.reclaimedFile += hot; st.hotEvicted += hot; }
  if (cold + hot > 0)
    log.push({ kind: "reclaim", text: `Reclaim dropped ${cold + hot} MiB of clean page cache${hot ? `, ${hot} MiB of it in active use: the API will read those pages from disk again` : ""}.` });
  let room = swapMax(st) - swapTotal(st);
  if (freed < need && room > 0) {
    let swapped = 0;
    // Swap out anon pages from the largest processes first (their cold pages are the LRU's tail).
    for (const p of [...PROCS].filter((q) => st.procs[q].alive).sort((a, b) => st.procs[b].anon - st.procs[a].anon)) {
      const take = Math.min(st.procs[p].anon, need - freed, room);
      if (take <= 0) continue;
      st.procs[p] = { ...st.procs[p], anon: st.procs[p].anon - take, swapped: st.procs[p].swapped + take };
      freed += take; swapped += take; room -= take;
    }
    if (swapped) { st.swappedOut += swapped; log.push({ kind: "swap", text: `Swapped ${swapped} MiB of anonymous memory out. It counts in memory.swap.current, and a later touch is a major fault.` }); }
  }
  return freed;
}

function kill(st: State, asked: ProcId, log: Log[]): ProcId | null {
  const alive = PROCS.filter((p) => badness(st, p) > -Infinity);
  if (!alive.length) return null;
  const scores = Object.fromEntries(PROCS.map((p) => [p, score(st, p)])) as Record<ProcId, number>;
  // The highest badness wins; on a tie the later task in the scan replaces the earlier one.
  const victim = alive.reduce((a, b) => (badness(st, b) >= badness(st, a) ? b : a));
  st.events.oom_kill++;
  if (st.cacheAtFirstKill === null) st.cacheAtFirstKill = st.hot + st.cold;
  if (!st.firstKill) st.firstKill = { asked, victim, scores };
  st.kills = [...st.kills, { asked, victim }];
  const v = st.procs[victim];
  log.push({ kind: "kill", text: `OOM killer: killed ${PROC_INFO[victim].name} (${v.anon + v.swapped} MiB, oom_score_adj ${v.adj}). It exits with SIGKILL, status 137${victim === "api" ? "; the container's main process is gone, so Kubernetes reports OOMKilled and restarts it" : ""}.` });
  st.procs[victim] = { ...v, anon: 0, swapped: 0, alive: false, exit: 137 };
  return victim;
}

function clone(st: State): State {
  return { ...st, procs: { ...st.procs }, events: { ...st.events }, log: [] };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  const next = apply(st, a);
  if (next === st || a.type === "reset") return next;
  const now = check(next);
  const f = next.found;
  const found: Goals = { cacheFirst: f.cacheFirst || now.cacheFirst, notTheAsker: f.notTheAsker || now.notTheAsker, steered: f.steered || now.steered, throttled: f.throttled || now.throttled, swapSaved: f.swapSaved || now.swapSaved };
  return { ...next, found };
}

function apply(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "restart": {
      const adj = Object.fromEntries(PROCS.map((p) => [p, st.procs[p].adj]));
      return { ...init(), swapOn: st.swapOn, highOn: st.highOn, procs: freshProcs(adj), found: st.found };
    }
    case "swap":
      return { ...st, swapOn: a.on };
    case "high":
      return { ...st, highOn: a.on };
    case "adj": {
      if (!st.procs[a.proc]) return st;
      const adj = Math.max(-1000, Math.min(1000, a.adj));
      return { ...st, procs: { ...st.procs, [a.proc]: { ...st.procs[a.proc], adj } } };
    }
    case "free": {
      const p = st.procs[a.proc];
      if (!p.alive || p.anon < STEP) return st;
      const s = clone(st);
      s.procs[a.proc] = { ...p, anon: p.anon - STEP };
      s.log = [{ kind: "alloc", text: `${PROC_INFO[a.proc].name} freed ${STEP} MiB.` }];
      return s;
    }
    case "read": {
      // The shipper reads log files: the page cache grows, and recycles its own cold pages at the limit.
      if (!st.procs.shipper.alive) return st;
      const s = clone(st);
      const log: Log[] = [{ kind: "read", text: `log-shipper read ${READ} MiB of log files into the page cache.` }];
      const over = usage(s) + READ - LIMIT;
      if (over > 0) { s.events.max++; reclaim(s, over, log); }
      const fits = Math.min(READ, LIMIT - usage(s));
      s.cold += Math.max(0, fits);
      s.log = log;
      return s;
    }
    case "alloc": {
      const p = st.procs[a.proc];
      if (!p.alive) return st;
      const s = clone(st);
      const log: Log[] = [{ kind: "alloc", text: `${PROC_INFO[a.proc].name} touches ${STEP} MiB of new heap.` }];
      for (;;) {
        const over = usage(s) + STEP - LIMIT;
        if (over <= 0) break;
        s.events.max++;
        const freed = reclaim(s, over, log);
        if (freed >= over) break;
        // Nothing left to reclaim: the allocation is about to fail.
        s.events.oom++;
        log.push({ kind: "oom", text: `memory.current is at the ${LIMIT} MiB limit and nothing more can be reclaimed.` });
        const victim = kill(s, a.proc, log);
        if (victim === null) { log.push({ kind: "fail", text: "No process can be killed. The allocation fails." }); s.log = log; return s; }
        if (victim === a.proc) { s.log = log; return s; }
      }
      s.procs[a.proc] = { ...s.procs[a.proc], anon: s.procs[a.proc].anon + STEP };
      if (s.highOn && usage(s) > HIGH) {
        // memory.high: the allocating task reclaims down to the boundary, and is throttled for what it cannot reclaim.
        s.events.high++;
        const over = usage(s) - HIGH;
        const freed = reclaim(s, over, log);
        const left = over - freed;
        const ms = Math.min(2000, 20 + left * 15);
        s.throttledMs += ms;
        log.push({ kind: "throttle", text: left > 0 ? `Above memory.high by ${left} MiB with nothing to reclaim: ${PROC_INFO[a.proc].name} is put to sleep for ${ms} ms on this allocation. Slow, not killed.` : `Above memory.high: ${PROC_INFO[a.proc].name} reclaimed ${freed} MiB itself before going on (${ms} ms).` });
      }
      s.log = log;
      return s;
    }
  }
}

/* ---------------- what the reader found ---------------- */

export interface Goals { cacheFirst: boolean; notTheAsker: boolean; steered: boolean; throttled: boolean; swapSaved: boolean }
function check(s: State): Goals {
  return {
    cacheFirst: s.reclaimedFile > 0,
    notTheAsker: s.kills.some((k) => k.asked !== k.victim),
    steered: s.kills.some((k) => k.victim !== "api") && s.procs.api.alive && s.events.oom_kill > 0,
    throttled: s.throttledMs >= 500 && s.events.oom_kill === 0,
    swapSaved: s.swappedOut > 0,
  };
}
