// G, M and P playground: a scheduler board. A batch of CPU-bound thumbnail jobs runs on a
// machine with 4 cores while a health check arrives part-way through.
//
// Purpose. After this, the reader can answer: "How many goroutines run at the same moment, and
// what happens to the rest?" Exactly one per P (GOMAXPROCS of them, each P held by an M, an OS
// thread). Every other runnable goroutine waits in a run queue. Spawning 64 goroutines instead of
// 4 does not finish CPU work sooner; it only makes the queues longer, and a latency-sensitive
// goroutine such as /healthz waits behind all of them.
//
// The model is scaled down so it fits on a screen and stays deterministic:
// - 1 tick = 5 ms. A goroutine runs for at most a 10 ms slice (2 ticks) before it is preempted.
// - Local run queues hold 16 goroutines (the real ones hold 256). When a queue is full, half of it
//   moves to the global queue, as runqputslow does.
// - A P with nothing to run takes from the global queue, then steals half of the longest queue.
//   Every 61st pick it checks the global queue first, as the runtime does.
// - In this model a preempted goroutine goes to the back of its own P's queue, and the health
//   check joins the back of P0's queue.
// - More Ps than cores do not add CPU: the cores are shared, so each running G gets less per tick.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const CORES = 4;
export const TICK_MS = 5;
export const SLICE = 2; // ticks: 10 ms, the runtime's forcePreemptNS
export const LOCAL_CAP = 16; // scaled down from 256
export const JOBS = 64;
export const JOB_TICKS = 4; // 20 ms of CPU per thumbnail
export const PROBE_AT = 6; // the health check arrives at 30 ms
export const MAX_PROCS = 8;

/** How many goroutines main starts. 64 means one per image; fewer means workers fed by a channel. */
export const SPAWN_OPTIONS = [1, 4, 16, 64] as const;
export const spawnName = (n: number) => n >= JOBS ? `${n}, one per image` : `${n} worker${n > 1 ? "s" : ""}`;

export type Kind = "job" | "worker" | "probe";
export interface G { id: number; kind: Kind; left: number; slice: number; born: number; finished: number | null }
export interface P { id: number; run: number | null; q: number[]; /** schedtick: how many times this P has picked a goroutine. */ n: number }

export interface RunResult {
  procs: number;
  goroutines: number;
  batchMs: number;
  probeWaitMs: number;
  maxQueued: number;
}

export type Guess = "spawn" | "same" | "pool";

export interface State {
  /** Goroutines main starts for the batch. */
  spawn: number;
  procs: number;
  t: number;
  started: boolean;
  gs: Record<number, G>;
  ps: P[];
  global: number[];
  nextId: number;
  /** Images not yet handed to a worker (pool design only). */
  channel: number;
  jobsDone: number;
  batchDoneAt: number | null;
  probeId: number | null;
  /** Most runnable goroutines waiting in queues at one moment in this run. */
  maxQueued: number;
  /** Work done per tick, for the throughput line. */
  history: number[];
  events: string[];
  guess: Guess | null;
  runs: RunResult[];
  /** This batch's result is already in runs. */
  recorded: boolean;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "spawn"; spawn: number }
  | { type: "procs"; procs: number }
  | { type: "start" }
  | { type: "tick" }
  | { type: "probe" }
  | { type: "finish" }
  | { type: "reset" };

const emptyPs = (n: number): P[] => Array.from({ length: n }, (_, id) => ({ id, run: null, q: [], n: 0 }));

export function init(): State {
  return {
    spawn: JOBS, procs: 4, t: 0, started: false, gs: {}, ps: emptyPs(4), global: [], nextId: 1,
    channel: 0, jobsDone: 0, batchDoneAt: null, probeId: null, maxQueued: 0, history: [], events: [],
    guess: null, runs: [], recorded: false,
  };
}

/* ---------------- helpers (all work on copies made by step) ---------------- */

interface Work { gs: Record<number, G>; ps: P[]; global: number[]; events: string[] }

/** runqput: to the back of the P's queue; if it is full, move half of it and g to the global queue. */
function runqput(w: Work, p: P, id: number) {
  if (p.q.length < LOCAL_CAP) { p.q.push(id); return; }
  const half = p.q.splice(0, LOCAL_CAP / 2);
  w.global.push(...half, id);
  w.events.push(`P${p.id}'s queue was full: ${half.length + 1} goroutines moved to the global queue.`);
}

/** findRunnable, simplified: (every 61st time the global queue), local queue, global queue, then steal half of the longest queue. */
function findRunnable(w: Work, p: P): number | null {
  p.n++;
  // Once every 61 picks, look at the global queue first, so nothing there waits forever.
  if (p.n % 61 === 0 && w.global.length) return w.global.shift()!;
  if (p.q.length) return p.q.shift()!;
  if (w.global.length) {
    const n = Math.min(w.global.length, Math.floor(w.global.length / w.ps.length) + 1, LOCAL_CAP / 2);
    const got = w.global.splice(0, n);
    p.q.push(...got.slice(1));
    return got[0];
  }
  let victim: P | null = null;
  for (const o of w.ps) if (o !== p && o.q.length > 0 && (!victim || o.q.length > victim.q.length)) victim = o;
  if (!victim) return null;
  const n = victim.q.length - Math.floor(victim.q.length / 2);
  const got = victim.q.splice(0, n);
  w.events.push(`P${p.id} was idle and stole ${n} from P${victim.id}.`);
  p.q.push(...got.slice(1));
  return got[0];
}

export const queued = (s: { ps: P[]; global: number[] }) => s.ps.reduce((a, p) => a + p.q.length, 0) + s.global.length;
export const running = (s: { ps: P[] }) => s.ps.filter((p) => p.run !== null).length;
export const goroutinesAlive = (s: State) => Object.values(s.gs).filter((g) => g.finished === null).length;

function clone(s: State): Work & { s: State } {
  const gs: Record<number, G> = {};
  for (const [k, g] of Object.entries(s.gs)) gs[+k] = { ...g };
  return { s, gs, ps: s.ps.map((p) => ({ ...p, q: [...p.q] })), global: [...s.global], events: [] };
}

function addProbe(s: State, w: Work): number {
  const id = s.nextId;
  w.gs[id] = { id, kind: "probe", left: 1, slice: 0, born: s.t, finished: null };
  w.ps[0].q.push(id); // the model lets the probe go over the cap, so it always waits in P0's queue
  w.events.push(`t=${s.t * TICK_MS} ms: GET /healthz arrives. Its goroutine joins the back of P0's queue.`);
  return id;
}

/* ---------------- one tick of the scheduler ---------------- */

function tick(s: State): State {
  if (!s.started || s.batchDoneAt !== null && (s.probeId === null || s.gs[s.probeId].finished !== null)) return s;
  const w = clone(s);
  let nextId = s.nextId, probeId = s.probeId;
  if (s.t === PROBE_AT && probeId === null) { probeId = addProbe(s, w); nextId++; }

  // 1. Every P without a goroutine looks for one.
  for (const p of w.ps) if (p.run === null) {
    const id = findRunnable(w, p);
    if (id !== null) { p.run = id; w.gs[id].slice = 0; }
  }
  // 2. The running goroutines share the cores.
  const r = running(w);
  const rate = r === 0 ? 0 : Math.min(1, CORES / r);
  let channel = s.channel, jobsDone = s.jobsDone;
  const t = s.t + 1;
  for (const p of w.ps) {
    if (p.run === null) continue;
    const g = w.gs[p.run];
    g.left -= rate; g.slice += 1;
    if (g.left <= 1e-9) {
      if (g.kind === "probe") {
        g.finished = t; p.run = null;
        w.events.push(`t=${t * TICK_MS} ms: /healthz answered after ${(t - g.born) * TICK_MS} ms.`);
        continue;
      }
      jobsDone++;
      if (g.kind === "worker" && channel > 0) { channel--; g.left = JOB_TICKS; }
      else { g.finished = t; p.run = null; continue; }
    }
    if (g.slice >= SLICE && p.run !== null) {
      // Preempted after its 10 ms slice. Only worth noting when someone was waiting.
      p.run = null;
      if (p.q.length === 0 && w.global.length === 0) { p.run = g.id; g.slice = 0; }
      else runqput(w, p, g.id);
    }
  }
  const batchDoneAt = s.batchDoneAt ?? (jobsDone >= JOBS ? t : null);
  if (batchDoneAt !== null && s.batchDoneAt === null) w.events.push(`t=${t * TICK_MS} ms: all ${JOBS} thumbnails done.`);
  const next: State = {
    ...s, gs: w.gs, ps: w.ps, global: w.global, t, nextId, probeId, channel, jobsDone, batchDoneAt,
    maxQueued: Math.max(s.maxQueued, queued(w)),
    history: [...s.history, r === 0 ? 0 : Math.min(r, CORES)],
    events: [...w.events.reverse(), ...s.events].slice(0, 30),
  };
  return recordIfFinished(next);
}

function recordIfFinished(s: State): State {
  const probeDone = s.probeId !== null && s.gs[s.probeId].finished !== null;
  if (s.recorded || s.batchDoneAt === null || !probeDone) return s;
  const pg = s.gs[s.probeId!];
  const res: RunResult = {
    procs: s.procs,
    goroutines: s.spawn,
    batchMs: s.batchDoneAt * TICK_MS,
    probeWaitMs: (pg.finished! - pg.born) * TICK_MS,
    maxQueued: s.maxQueued,
  };
  return { ...s, runs: [...s.runs, res], recorded: true };
}

/* ---------------- step ---------------- */

function fresh(s: State, patch: Partial<State>): State {
  const base = { ...init(), guess: s.guess, runs: s.runs, spawn: s.spawn, procs: s.procs, ...patch };
  return { ...base, ps: emptyPs(base.procs) };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return s.runs.length ? s : { ...s, guess: a.guess };
    case "spawn":
      return fresh(s, { spawn: Math.max(1, Math.min(JOBS, a.spawn)) });
    case "procs": {
      const procs = Math.max(1, Math.min(MAX_PROCS, a.procs));
      if (!s.started || s.batchDoneAt !== null) return fresh(s, { procs });
      // Changing GOMAXPROCS mid-run: removed Ps hand their goroutines to the global queue.
      const w = clone(s);
      const ps = Array.from({ length: procs }, (_, id) => w.ps[id] ?? { id, run: null, q: [], n: 0 });
      for (const gone of w.ps.slice(procs)) {
        if (gone.run !== null) w.global.push(gone.run);
        w.global.push(...gone.q);
      }
      const ev = procs < s.procs ? `GOMAXPROCS ${s.procs} → ${procs}: the removed Ps' goroutines moved to the global queue.` : `GOMAXPROCS ${s.procs} → ${procs}: ${procs - s.procs} new P${procs - s.procs > 1 ? "s" : ""}, each needs an M.`;
      return { ...s, procs, ps, global: w.global, events: [ev, ...s.events].slice(0, 30) };
    }
    case "start": {
      if (s.started) return s;
      const w: Work = { gs: {}, ps: emptyPs(s.procs), global: [], events: [] };
      let id = 1;
      const n = s.spawn, perItem = n >= JOBS;
      for (let i = 0; i < n; i++, id++) {
        w.gs[id] = { id, kind: perItem ? "job" : "worker", left: JOB_TICKS, slice: 0, born: 0, finished: null };
        runqput(w, w.ps[0], id);
      }
      const ev = perItem
        ? `main ran go resize(img) ${JOBS} times on P0. Every new goroutine starts on P0's queue.`
        : `main ran go worker() ${n} time${n > 1 ? "s" : ""} on P0 and feeds ${JOBS} images through a channel.`;
      return {
        ...s, started: true, gs: w.gs, ps: w.ps, global: w.global, nextId: id,
        channel: perItem ? 0 : JOBS - n, maxQueued: queued(w),
        events: [...w.events.reverse(), ev],
      };
    }
    case "tick":
      return tick(s);
    case "probe": {
      if (!s.started || (s.probeId !== null && s.gs[s.probeId].finished === null)) return s;
      if (s.probeId !== null) return s; // one health check per run keeps runs comparable
      const w = clone(s);
      const id = addProbe(s, w);
      return { ...s, gs: w.gs, ps: w.ps, global: w.global, nextId: s.nextId + 1, probeId: id, events: [...w.events, ...s.events].slice(0, 30) };
    }
    case "finish": {
      let cur = s.started ? s : step(s, { type: "start" });
      for (let i = 0; i < 2000; i++) {
        const nx = tick(cur);
        if (nx === cur) break;
        cur = nx;
      }
      return cur;
    }
  }
}

/** Plays one whole run of a design and GOMAXPROCS from a fresh board. Used by tests and the summary. */
export function simulate(spawn: number, procs: number): RunResult {
  let s = step(step(init(), { type: "spawn", spawn }), { type: "procs", procs });
  s = step(s, { type: "finish" });
  return s.runs[s.runs.length - 1];
}
