// Preemption: a timeline of Ps while one goroutine runs a tight loop with no function calls,
// requests keep arriving, and a garbage collection needs to stop the world.
//
// Purpose. After this, the reader can answer: "Why could one tight loop freeze a whole Go program
// before Go 1.14, even with spare Ps, and what changed?" Before 1.14 a goroutine could only be
// stopped at a function call, so the GC's stop-the-world waited for the loop to end while every
// other P sat stopped. Since 1.14 the runtime interrupts the loop with a signal: the world stops
// within a moment, and other goroutines wait at most about one 10 ms slice.
//
// Scaled, deterministic model:
// - 1 tick = 1 ms. Requests (/healthz and API calls) arrive every 2 ms and need 1 ms of CPU each.
// - At HOG_AT the fingerprint goroutine starts: HOG_MS of CPU in a loop with no calls.
// - sysmon asks for preemption once a goroutine has run SLICE_MS without a break.
// - At GC_AT a garbage collection starts and must stop the world: every P has to reach a safe
//   point. Stopped Ps run nothing. Once all are stopped, the stop-the-world work takes STW_MS.
// - Preemption modes:
//   coop    Go 1.13: only a function call can notice a preemption request. The loop has none.
//   gosched Go 1.13 with the old workaround: runtime.Gosched() after every 1 MiB (about 1 ms).
//   async   Go 1.14+: a signal (SIGURG) stops the loop at once.
// - A preempted or yielding goroutine goes to the back of the global queue.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const HOG_AT = 5;
export const HOG_MS = 80;
export const GC_AT = 20;
export const STW_MS = 1;
export const SLICE_MS = 10;
export const ARRIVE_EVERY = 2;
export const ARRIVE_UNTIL = 120;
export const DEADLINE = 25;
export const END = 220;

export type Mode = "coop" | "gosched" | "async";
export const MODE_NAME: Record<Mode, string> = {
  coop: "Go 1.13, cooperative only",
  gosched: "Go 1.13 + Gosched per MiB",
  async: "Go 1.14+, signals",
};

export type Item = { kind: "req"; id: number; born: number } | { kind: "hog" };
export interface P { id: number; run: Item | null; since: number; stopped: boolean }
export type GcPhase = "off" | "waiting" | "stw" | "done";
export type CellKind = "hog" | "req" | "idle" | "stopped" | "stw";
export type Mark = { t: number; kind: "signal" | "ask" | "gc" | "world" };

export interface RunResult {
  mode: Mode; procs: number; gc: boolean;
  pauseMs: number | null; worstWaitMs: number; late: number; served: number; hogDoneAt: number; signals: number; yields: number;
}

export type Guess = "p1" | "slice" | "loop";

export interface State {
  mode: Mode; procs: number; gc: boolean;
  t: number; started: boolean; recorded: boolean;
  queue: Item[]; ps: P[]; nextId: number;
  hogLeft: number; hogDoneAt: number | null; preemptPending: boolean;
  gcPhase: GcPhase; gcAskedAt: number | null; stwEnd: number | null; pause: number | null;
  served: number; late: number; worstWait: number; signals: number; yields: number;
  timeline: CellKind[][]; marks: Mark[]; events: string[];
  guess: Guess | null; runs: RunResult[];
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "mode"; mode: Mode }
  | { type: "procs"; procs: number }
  | { type: "gc"; on: boolean }
  | { type: "tick" }
  | { type: "finish" }
  | { type: "clear" }
  | { type: "reset" };

const board = (procs: number) => ({
  queue: [] as Item[],
  ps: Array.from({ length: procs }, (_, id) => ({ id, run: null, since: 0, stopped: false }) as P),
  nextId: 1, hogLeft: HOG_MS, hogDoneAt: null, preemptPending: false,
  gcPhase: "off" as GcPhase, gcAskedAt: null, stwEnd: null, pause: null,
  served: 0, late: 0, worstWait: 0, signals: 0, yields: 0,
  timeline: [] as CellKind[][], marks: [] as Mark[], events: [] as string[],
});

export function init(): State {
  return { mode: "coop", procs: 2, gc: true, t: 0, started: false, recorded: false, ...board(2), guess: null, runs: [] };
}

export const waiting = (s: { queue: Item[] }) => s.queue.filter((i) => i.kind === "req").length;
export const hogOn = (s: { ps: P[] }) => s.ps.find((p) => p.run?.kind === "hog") ?? null;

function tick(s: State): State {
  if (s.recorded) return s;
  const t = s.t;
  const queue = [...s.queue];
  const ps = s.ps.map((p) => ({ ...p }));
  const ev: string[] = [];
  const marks = [...s.marks];
  let { nextId, hogLeft, hogDoneAt, preemptPending, gcPhase, gcAskedAt, stwEnd, pause, served, late, worstWait, signals, yields } = s;

  // 1. Arrivals, and the fingerprint goroutine starting.
  if (t < ARRIVE_UNTIL && t % ARRIVE_EVERY === 0) queue.push({ kind: "req", id: nextId++, born: t });
  if (t === HOG_AT) { queue.unshift({ kind: "hog" }); ev.push(`${t} ms: the fingerprint goroutine starts its loop over a 1 GiB image.`); }

  // 2. The GC asks to stop the world. It asks every running goroutine to stop.
  if (s.gc && t === GC_AT) {
    gcPhase = "waiting"; gcAskedAt = t; marks.push({ t, kind: "ask" });
    ev.push(`${t} ms: a GC cycle starts and asks every P to stop at a safe point.`);
    if (hogOn({ ps })) {
      preemptPending = true;
      if (s.mode === "async") { signals++; marks.push({ t, kind: "signal" }); }
    }
  }

  // 3. sysmon: a goroutine that has run SLICE_MS without a break gets a preemption request.
  const hp = hogOn({ ps });
  if (hp && gcPhase !== "waiting" && t - hp.since >= SLICE_MS && !preemptPending) {
    preemptPending = true;
    if (s.mode === "async") { signals++; marks.push({ t, kind: "signal" }); ev.push(`${t} ms: sysmon sees the loop has run ${SLICE_MS} ms and sends SIGURG to its thread.`); }
    else if (s.mode === "coop" && !s.preemptPending) ev.push(`${t} ms: sysmon asks the loop to yield. Nothing happens: the loop makes no function call, so it never checks.`);
  }

  // 4. Does the loop stop now?
  const hp2 = hogOn({ ps });
  if (hp2) {
    if (s.mode === "async" && preemptPending) {
      hp2.run = null; queue.push({ kind: "hog" }); preemptPending = false;
      ev.push(`${t} ms: the signal handler finds the loop at a safe point and switches it out. It goes to the global queue.`);
    } else if (s.mode === "gosched" && t > hp2.since) {
      hp2.run = null; queue.push({ kind: "hog" }); preemptPending = false; yields++;
    }
  }

  // 5. Stop the world: a P with nothing running stops. When all have stopped, run the STW work.
  if (gcPhase === "stw" && stwEnd !== null && t >= stwEnd) {
    gcPhase = "done"; pause = t - (gcAskedAt ?? t); marks.push({ t, kind: "world" });
    for (const p of ps) p.stopped = false;
    ev.push(`${t} ms: the world restarts. The GC paused the program for ${pause} ms. Marking now runs alongside it.`);
  }
  if (gcPhase === "waiting") {
    for (const p of ps) if (p.run === null && !p.stopped) p.stopped = true;
    if (ps.every((p) => p.stopped)) {
      gcPhase = "stw"; stwEnd = t + STW_MS; marks.push({ t, kind: "gc" });
      ev.push(`${t} ms: every P has stopped, ${t - (gcAskedAt ?? t)} ms after the GC asked. The stop-the-world work runs.`);
    }
  }

  // 6. Free Ps pick the next goroutine from the queue.
  for (const p of ps) {
    if (p.stopped || p.run !== null || !queue.length) continue;
    const it = queue.shift()!;
    p.run = it;
    if (it.kind === "hog") { p.since = t; preemptPending = false; }
    else {
      const wait = t - it.born;
      worstWait = Math.max(worstWait, wait);
      if (wait > DEADLINE) late++;
    }
  }

  // 7. Run one millisecond.
  const cells: CellKind[] = ps.map((p) => {
    if (p.stopped) return gcPhase === "stw" ? "stw" : "stopped";
    if (!p.run) return "idle";
    return p.run.kind;
  });
  for (const p of ps) {
    if (!p.run || p.stopped) continue;
    if (p.run.kind === "hog") {
      hogLeft--;
      if (hogLeft <= 0) { hogDoneAt = t + 1; p.run = null; preemptPending = false; ev.push(`${t + 1} ms: the loop ends and the goroutine returns.`); }
    } else { served++; p.run = null; }
  }

  const next: State = {
    ...s, t: t + 1, started: true, queue, ps, nextId, hogLeft, hogDoneAt, preemptPending, gcPhase, gcAskedAt, stwEnd, pause,
    served, late, worstWait, signals, yields, timeline: [...s.timeline, cells], marks,
    events: [...ev.reverse(), ...s.events].slice(0, 40),
  };
  const quiet = t + 1 >= ARRIVE_UNTIL && hogDoneAt !== null && !queue.length && ps.every((p) => !p.run) && gcPhase !== "waiting" && gcPhase !== "stw";
  if (!(quiet || t + 1 >= END)) return next;
  const res: RunResult = { mode: s.mode, procs: s.procs, gc: s.gc, pauseMs: pause, worstWaitMs: worstWait, late, served, hogDoneAt: hogDoneAt ?? END, signals, yields };
  return { ...next, recorded: true, runs: [...s.runs, res] };
}

function fresh(s: State, patch: Partial<State>): State {
  const procs = patch.procs ?? s.procs;
  return { ...s, t: 0, started: false, recorded: false, ...board(procs), ...patch };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.runs.some((r) => r.mode === "coop" && r.gc) ? s : { ...s, guess: a.guess };
    case "mode": return fresh(s, { mode: a.mode });
    case "procs": return fresh(s, { procs: Math.max(1, Math.min(2, a.procs)) });
    case "gc": return fresh(s, { gc: a.on });
    case "clear": return fresh(s, {});
    case "tick": return tick(s);
    case "finish": {
      let cur = s;
      for (let i = 0; i <= END; i++) { const nx = tick(cur); if (nx === cur) break; cur = nx; }
      return cur;
    }
  }
}

/** Plays a whole run from a fresh board. Used by tests. */
export function simulate(mode: Mode, procs = 2, gc = true): RunResult {
  let s = [{ type: "mode", mode }, { type: "procs", procs }, { type: "gc", on: gc }, { type: "finish" }].reduce((x, a) => step(x, a as Action), init());
  return s.runs[s.runs.length - 1];
}
