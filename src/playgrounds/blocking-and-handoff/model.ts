// When a goroutine blocks: a timeline of Ms, Ps and the goroutines they run, while one or more
// goroutines block for 30 ms in the middle of steady request traffic.
//
// Purpose. After this, the reader can answer: "When a goroutine blocks, does it take a thread
// and a P with it?" It depends on how it blocks. A channel wait or a network read parks the
// goroutine and the thread runs the next one at once. A blocking system call (a file read on a
// stalled NFS mount, a cgo call) takes the thread into the kernel with it, and the P would sit
// idle with it if sysmon did not notice and hand the P to another thread. The metric is how many
// other goroutines keep running, and the price is extra OS threads.
//
// Scaled, deterministic model:
// - 1 tick = 1 ms. GOMAXPROCS = 2. Requests arrive at 1.5 per ms (1, 2, 1, 2 ...), each needs
//   1 ms of CPU, alternating between P0's and P1's queues. Two Ps keep up; one P cannot.
// - At 5 ms, the importer goroutine(s) start their blocking operation, which lasts 30 ms.
// - sysmon looks at every P each tick (the real one sleeps 20 µs to 10 ms between looks). It
//   retakes a P that it has seen in the same syscall on an earlier look, unless the P has no
//   work, another P is idle, and the syscall is younger than 10 ms (the rule in retake()).
// - A P with nothing to run takes from the global queue, then steals half of the longest queue.
// - A netpoller wake-up puts the goroutine on the global queue; a channel send puts the
//   receiver at the back of P0's queue.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const PROCS = 2;
export const BLOCK_AT = 5;
export const BLOCK_MS = 30;
export const ARRIVALS_UNTIL = 50;
export const END = 90;
export const RETAKE_MAX_MS = 10;

export type Op = "chan" | "net" | "file";
export const OP_NAME: Record<Op, string> = {
  chan: "channel receive",
  net: "network read",
  file: "file read (stalled NFS)",
};
export const OP_CALL: Record<Op, string> = {
  chan: "job := <-jobs",
  net: "conn.Read(buf)",
  file: "f.Read(buf)",
};

export type GKind = "req" | "imp";
export type GState = "runnable" | "running" | "waiting" | "syscall" | "done";
export interface G {
  id: number; kind: GKind; state: GState; left: number; born: number;
  started: number | null; finished: number | null;
  /** Importer: has it already made its blocking call? */
  blocked: boolean;
  /** Where a waiting goroutine is parked. */
  parkedOn: "chan" | "netpoller" | null;
  wakeAt: number | null;
}
export type PStatus = "running" | "idle" | "syscall";
export interface P { id: number; status: PStatus; m: number | null; run: number | null; q: number[]; syscallSince: number | null; seen: boolean }
export type MState = "running" | "spinning" | "syscall" | "idle";
export interface M { id: number; state: MState; p: number | null; g: number | null; returnAt: number | null }

/** One cell of the timeline: what an M was doing during that millisecond. */
export type Cell = { m: number; what: "req" | "imp" | "syscall" | "idle" | "none"; p: number | null };

export interface RunResult {
  op: Op; sysmon: boolean; blockers: number;
  served: number; servedDuringBlock: number; worstWaitMs: number; threads: number; idleThreads: number; handoffs: number;
}

export type Guess = "park" | "stall" | "handoff";

export interface State {
  op: Op;
  sysmon: boolean;
  blockers: number;
  t: number;
  started: boolean;
  gs: Record<number, G>;
  ps: P[];
  ms: M[];
  global: number[];
  nextId: number;
  served: number;
  servedDuringBlock: number;
  worstWait: number;
  handoffs: number;
  /** Ticks at which sysmon handed a P to another thread. */
  handoffAt: number[];
  /** timeline[t] = what each M did during millisecond t. */
  timeline: Cell[][];
  events: string[];
  guess: Guess | null;
  runs: RunResult[];
  recorded: boolean;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "op"; op: Op }
  | { type: "sysmon"; on: boolean }
  | { type: "blockers"; n: number }
  | { type: "start" }
  | { type: "tick" }
  | { type: "finish" }
  | { type: "clear" }
  | { type: "reset" };

function board(): Pick<State, "ps" | "ms" | "gs" | "global" | "nextId"> {
  return {
    ps: Array.from({ length: PROCS }, (_, id) => ({ id, status: "running" as PStatus, m: id, run: null, q: [], syscallSince: null, seen: false })),
    ms: Array.from({ length: PROCS }, (_, id) => ({ id, state: "running" as MState, p: id, g: null, returnAt: null })),
    gs: {}, global: [], nextId: 1,
  };
}

export function init(): State {
  return {
    op: "file", sysmon: true, blockers: 1, t: 0, started: false, ...board(),
    served: 0, servedDuringBlock: 0, worstWait: 0, handoffs: 0, handoffAt: [], timeline: [], events: [],
    guess: null, runs: [], recorded: false,
  };
}

export const arrivalsAt = (t: number) => (t < ARRIVALS_UNTIL ? (t % 2 === 0 ? 1 : 2) : 0);
export const totalArrivals = () => { let n = 0; for (let t = 0; t < ARRIVALS_UNTIL; t++) n += arrivalsAt(t); return n; };
/** Requests that arrive while the importer is blocked. */
export const ARRIVALS_IN_BLOCK = (() => { let n = 0; for (let t = BLOCK_AT; t < BLOCK_AT + BLOCK_MS; t++) n += arrivalsAt(t); return n; })();
export const queuedCount = (s: { ps: P[]; global: number[] }) => s.ps.reduce((a, p) => a + p.q.length, 0) + s.global.length;
export const threadsInSyscall = (s: { ms: M[] }) => s.ms.filter((m) => m.state === "syscall").length;
export const idleThreads = (s: { ms: M[] }) => s.ms.filter((m) => m.state === "idle").length;
export const parked = (s: State, on: "chan" | "netpoller") => Object.values(s.gs).filter((g) => g.state === "waiting" && g.parkedOn === on);

/* ---------------- one tick ---------------- */

interface W { s: State; gs: Record<number, G>; ps: P[]; ms: M[]; global: number[]; ev: string[]; nextId: number; handoffs: number; handoffAt: number[] }

const ms = (t: number) => `${t} ms`;

/** startm: an idle thread if there is one, else a new thread. */
function startM(w: W, p: P): M {
  let m = w.ms.find((x) => x.state === "idle");
  if (!m) { m = { id: w.ms.length, state: "running", p: null, g: null, returnAt: null }; w.ms.push(m); w.ev.push(`New OS thread M${m.id} created to run P${p.id}.`); }
  else w.ev.push(`Idle thread M${m.id} woken to run P${p.id}.`);
  m.state = "running"; m.p = p.id; p.m = m.id; p.status = "running";
  return m;
}

function findRunnable(w: W, p: P): number | null {
  if (p.q.length) return p.q.shift()!;
  if (w.global.length) return w.global.shift()!;
  let victim: P | null = null;
  for (const o of w.ps) if (o !== p && o.q.length > 1 && (!victim || o.q.length > victim.q.length)) victim = o;
  if (!victim) return null;
  const n = victim.q.length - Math.floor(victim.q.length / 2);
  const got = victim.q.splice(0, n);
  p.q.push(...got.slice(1));
  return got[0];
}

function tick(s: State): State {
  if (!s.started || s.recorded) return s;
  const gs: Record<number, G> = {};
  for (const [k, g] of Object.entries(s.gs)) gs[+k] = { ...g };
  const w: W = {
    s, gs, ps: s.ps.map((p) => ({ ...p, q: [...p.q] })), ms: s.ms.map((m) => ({ ...m })),
    global: [...s.global], ev: [], nextId: s.nextId, handoffs: s.handoffs, handoffAt: [...s.handoffAt],
  };
  const t = s.t;

  // 1. New requests arrive. The importers start at BLOCK_AT, at the front of the queues.
  for (let i = 0; i < arrivalsAt(t); i++) {
    const id = w.nextId++;
    w.gs[id] = { id, kind: "req", state: "runnable", left: 1, born: t, started: null, finished: null, blocked: false, parkedOn: null, wakeAt: null };
    w.ps[(id + 1) % PROCS].q.push(id);
  }
  if (t === BLOCK_AT) {
    for (let i = 0; i < s.blockers; i++) {
      const id = w.nextId++;
      w.gs[id] = { id, kind: "imp", state: "runnable", left: 1, born: t, started: null, finished: null, blocked: false, parkedOn: null, wakeAt: null };
      w.ps[i % PROCS].q.unshift(id);
    }
  }

  // 2. Wake-ups: data on a socket, a value on a channel, a syscall returning.
  for (const g of Object.values(w.gs)) {
    if (g.state !== "waiting" || g.wakeAt === null || g.wakeAt > t) continue;
    g.state = "runnable"; g.wakeAt = null;
    if (g.parkedOn === "netpoller") { w.global.push(g.id); w.ev.push(`${ms(t)}: data arrived. The netpoller hands G${g.id} back to a run queue. No thread was used while it waited.`); }
    else { w.ps[0].q.push(g.id); w.ev.push(`${ms(t)}: a sender put a job on the channel and readied G${g.id}.`); }
    g.parkedOn = null;
  }
  for (const m of w.ms) {
    if (m.state !== "syscall" || m.returnAt === null || m.returnAt > t) continue;
    const g = w.gs[m.g!];
    m.returnAt = null;
    // exitsyscall: keep the old P if nobody took it, else any idle P, else give up.
    const own = w.ps.find((p) => p.status === "syscall" && p.m === m.id);
    const idle = own ?? w.ps.find((p) => p.status === "idle");
    if (idle) {
      idle.status = "running"; idle.m = m.id; idle.syscallSince = null; idle.seen = false;
      m.state = "running"; m.p = idle.id; g.state = "running"; idle.run = g.id;
      w.ev.push(own ? `${ms(t)}: G${g.id}'s read returned. Its P was still there, so M${m.id} carries on.` : `${ms(t)}: G${g.id}'s read returned. M${m.id} found idle P${idle.id}.`);
    } else {
      g.state = "runnable"; w.global.push(g.id);
      m.state = "idle"; m.g = null; m.p = null;
      w.ev.push(`${ms(t)}: G${g.id}'s read returned, but every P is taken. G${g.id} goes to the global queue and M${m.id} parks as an idle thread.`);
    }
  }

  // 3. sysmon: retake Ps that sit in a syscall.
  if (s.sysmon) {
    for (const p of w.ps) {
      if (p.status !== "syscall") continue;
      if (!p.seen) { p.seen = true; continue; }
      const someoneIdle = w.ps.some((o) => o !== p && o.status === "idle");
      const young = t - (p.syscallSince ?? t) < RETAKE_MAX_MS;
      if (p.q.length === 0 && w.global.length === 0 && someoneIdle && young) continue;
      const oldM = p.m;
      p.status = "idle"; p.m = null; p.syscallSince = null; p.seen = false;
      w.handoffs++; w.handoffAt.push(t);
      w.ev.push(`${ms(t)}: sysmon saw P${p.id} stuck in M${oldM}'s syscall and handed it off.`);
      startM(w, p);
    }
  }

  // 4. Every P that can run looks for a goroutine. Idle Ps with work get a thread.
  for (const p of w.ps) {
    if (p.status === "syscall" || p.run !== null) continue;
    const id = findRunnable(w, p);
    if (id === null) {
      if (p.status === "running" && p.m !== null) { const m = w.ms[p.m]; m.state = "spinning"; m.g = null; }
      continue;
    }
    if (p.m === null) startM(w, p);
    p.status = "running"; p.run = id;
    const m = w.ms[p.m!]; m.state = "running"; m.g = id;
    const g = w.gs[id]; g.state = "running";
    if (g.started === null) g.started = t;
  }

  // 5. Run one millisecond.
  const cells: Cell[] = w.ms.map((m) => ({ m: m.id, what: m.state === "syscall" ? "syscall" : "idle", p: m.p }));
  let served = s.served, during = s.servedDuringBlock, worst = s.worstWait;
  for (const p of w.ps) {
    if (p.run === null || p.status !== "running") continue;
    const g = w.gs[p.run], m = w.ms[p.m!];
    m.g = g.id;
    if (g.kind === "imp" && !g.blocked) {
      g.blocked = true;
      cells[m.id] = { m: m.id, what: "imp", p: p.id };
      if (s.op === "file") {
        g.state = "syscall"; m.state = "syscall"; m.returnAt = t + BLOCK_MS;
        p.status = "syscall"; p.run = null; p.syscallSince = t; p.seen = false;
        w.ev.push(`${ms(t)}: G${g.id} calls f.Read on a stalled mount. M${m.id} enters the kernel with it and P${p.id} waits in syscall state.`);
      } else {
        g.state = "waiting"; g.parkedOn = s.op === "net" ? "netpoller" : "chan"; g.wakeAt = t + BLOCK_MS;
        p.run = null; m.g = null;
        w.ev.push(s.op === "net"
          ? `${ms(t)}: G${g.id} calls conn.Read. No data yet, so it parks on the netpoller and M${m.id} moves on.`
          : `${ms(t)}: G${g.id} waits on <-jobs. It parks on the channel and M${m.id} moves on.`);
      }
      continue;
    }
    cells[m.id] = { m: m.id, what: g.kind, p: p.id };
    g.left -= 1;
    if (g.left <= 0) {
      g.state = "done"; g.finished = t + 1; p.run = null; m.g = null;
      if (g.kind === "req") {
        served++;
        if (t >= BLOCK_AT && t < BLOCK_AT + BLOCK_MS) during++;
        worst = Math.max(worst, (g.started ?? t) - g.born);
      }
    }
  }
  for (const m of w.ms) if (m.state === "spinning" && cells[m.id].what === "idle") cells[m.id] = { m: m.id, what: "none", p: m.p };

  const next: State = {
    ...s, t: t + 1, gs: w.gs, ps: w.ps, ms: w.ms, global: w.global, nextId: w.nextId,
    served, servedDuringBlock: during, worstWait: worst, handoffs: w.handoffs, handoffAt: w.handoffAt,
    timeline: [...s.timeline, cells],
    events: [...w.ev.reverse(), ...s.events].slice(0, 40),
  };
  const allDone = t + 1 >= END || (t + 1 >= ARRIVALS_UNTIL && Object.values(w.gs).every((g) => g.state === "done"));
  if (!allDone) return next;
  const res: RunResult = {
    op: s.op, sysmon: s.sysmon, blockers: s.blockers, served, servedDuringBlock: during, worstWaitMs: worst,
    threads: w.ms.length, idleThreads: idleThreads(w), handoffs: w.handoffs,
  };
  return { ...next, runs: [...s.runs, res], recorded: true };
}

/* ---------------- step ---------------- */

function fresh(s: State, patch: Partial<State>): State {
  return { ...init(), guess: s.guess, runs: s.runs, op: s.op, sysmon: s.sysmon, blockers: s.blockers, ...patch };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.runs.some((r) => r.op === "file") ? s : { ...s, guess: a.guess };
    case "op": return fresh(s, { op: a.op });
    case "sysmon": return fresh(s, { sysmon: a.on });
    case "blockers": return fresh(s, { blockers: Math.max(1, Math.min(8, a.n)) });
    case "clear": return fresh(s, {});
    case "start": return s.started ? s : { ...s, started: true };
    case "tick": return tick(s.started ? s : { ...s, started: true });
    case "finish": {
      let cur = s.started ? s : { ...s, started: true };
      for (let i = 0; i <= END; i++) { const nx = tick(cur); if (nx === cur) break; cur = nx; }
      return cur;
    }
  }
}

/** Plays a whole run from a fresh board. Used by tests. */
export function simulate(op: Op, sysmon: boolean, blockers = 1): RunResult {
  let s = step(step(step(init(), { type: "op", op }), { type: "sysmon", on: sysmon }), { type: "blockers", n: blockers });
  s = step(s, { type: "finish" });
  return s.runs[s.runs.length - 1];
}
