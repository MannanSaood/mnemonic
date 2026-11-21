// Limited direct execution playground: one CPU, two processes, and the timer that keeps the OS
// in charge.
//
// Purpose. After this, the reader can answer: "How does the OS get the CPU back from a program
// that never gives it up, and what does each switch cost?" Only a trap brings the kernel back:
// a system call, a device interrupt or the timer interrupt. Without a timer, a process that never
// makes a system call keeps the CPU forever. With one, the interval is a price: a long interval
// leaves a waiting process waiting; a very short one spends the CPU on traps, register saves and
// cold caches instead of work.
//
// The machine, scaled to fit a screen and stay deterministic (1 step = 1 µs):
// - Process A is a batch job: a CPU loop that never blocks. In "loops" mode it never makes a
//   system call. In "yields" mode it calls sched_yield() every 5 ms of its own run time.
// - Process B is an API server. A request arrives every 10 ms (10 of them); each needs 2 ms of
//   CPU. When B has nothing to do it blocks in a system call, which hands the CPU back.
// - A request arrives as a network interrupt: a trap into the kernel that marks B ready and then
//   returns to whatever was running. This simple scheduler switches only on the timer or when a
//   process gives up the CPU (Linux also preempts on wake-up; see the lesson's Deep notes).
// - Costs: a trap (enter and leave the kernel) 1 µs; a context switch (save A's registers, load
//   B's, switch kernel stacks) 4 µs; after a switch the incoming process spends 40 µs refilling
//   caches and TLB before it does useful work again. Orders of magnitude, not a benchmark.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const WINDOW = 120_000; // µs simulated
export const TRAP = 1;
export const SWITCH = 4;
export const WARM = 40;
export const REQ_EVERY = 10_000;
export const REQ_FIRST = 1_300;
export const REQ_COUNT = 10;
export const REQ_CPU = 2_000;
export const YIELD_EVERY = 5_000;

/** Timer interrupt interval in µs, or null for no timer at all (cooperative). */
export type Timer = null | 100 | 1000 | 4000 | 10000 | 50000;
export const TIMERS: Timer[] = [null, 100, 1000, 4000, 10000, 50000];
export type BatchMode = "loops" | "yields";
export type Kind = "A" | "B" | "kernel" | "warm";
export type Guess = "slice" | "finish" | "never";

export interface Seg { kind: Kind; start: number; end: number }

export interface RunResult {
  timer: Timer;
  batch: BatchMode;
  aWorkUs: number;
  bWorkUs: number;
  kernelUs: number;
  warmUs: number;
  traps: number;
  switches: number;
  voluntary: number;
  involuntary: number;
  answered: number;
  worstMs: number | null; // worst response of the answered requests
  avgMs: number | null;
  /** Fraction of the CPU spent in traps, switches and cache refill. */
  overhead: number;
  segs: Seg[];
}

const fmtTimer = (t: Timer) => (t === null ? "no timer" : t >= 1000 ? `${t / 1000} ms` : `${t} µs`);
export const timerName = fmtTimer;

/** Runs the machine for WINDOW µs with one configuration. Pure and deterministic. */
export function simulate(timer: Timer, batch: BatchMode): RunResult {
  let cur: "A" | "B" = "A";
  let kernelLeft = 0;
  let pending: "A" | "B" | null = null;
  let pendingVoluntary = false;
  let warm = 0;
  let aSince = 0;
  const queue: { arr: number; left: number }[] = [];
  const done: number[] = []; // response times in µs
  let aWorkUs = 0, bWorkUs = 0, kernelUs = 0, warmUs = 0, traps = 0, voluntary = 0, involuntary = 0;
  const segs: Seg[] = [];
  const mark = (kind: Kind, t: number) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind && last.end === t) last.end = t + 1;
    else segs.push({ kind, start: t, end: t + 1 });
  };
  const switchTo = (to: "A" | "B", vol: boolean) => { pending = to; pendingVoluntary = vol; kernelLeft += SWITCH; };

  for (let t = 0; t < WINDOW; t++) {
    // Device interrupt: a request arrives. The kernel marks B ready and returns.
    const k = (t - REQ_FIRST) / REQ_EVERY;
    if (t >= REQ_FIRST && Number.isInteger(k) && k < REQ_COUNT) {
      queue.push({ arr: t, left: REQ_CPU });
      kernelLeft += TRAP; traps++;
    }
    // Timer interrupt: the kernel gets control and may switch.
    if (timer !== null && t > 0 && t % timer === 0) {
      kernelLeft += TRAP; traps++;
      if (pending === null) {
        const otherReady = cur === "A" ? queue.length > 0 : true;
        if (otherReady) switchTo(cur === "A" ? "B" : "A", false);
      }
    }
    if (kernelLeft > 0) {
      kernelLeft--; kernelUs++; mark("kernel", t);
      if (kernelLeft === 0 && pending !== null) {
        cur = pending; pending = null; warm = WARM;
        if (pendingVoluntary) voluntary++; else involuntary++;
      }
      continue;
    }
    if (warm > 0) { warm--; warmUs++; mark("warm", t); continue; }
    if (cur === "A") {
      aWorkUs++; aSince++; mark("A", t);
      if (batch === "yields" && aSince >= YIELD_EVERY) {
        aSince = 0; kernelLeft += TRAP; traps++;
        if (queue.length > 0) switchTo("B", true);
      }
    } else {
      const r = queue[0];
      bWorkUs++; mark("B", t);
      r.left--;
      if (r.left === 0) {
        done.push(t + 1 - r.arr);
        queue.shift();
        if (queue.length === 0) { kernelLeft += TRAP; traps++; switchTo("A", true); } // B blocks waiting for the next request
      }
    }
  }
  const worst = done.length ? Math.max(...done) : null;
  return {
    timer, batch, aWorkUs, bWorkUs, kernelUs, warmUs, traps,
    switches: voluntary + involuntary, voluntary, involuntary,
    answered: done.length,
    worstMs: worst === null ? null : worst / 1000,
    avgMs: done.length ? done.reduce((a, b) => a + b, 0) / done.length / 1000 : null,
    overhead: (kernelUs + warmUs) / WINDOW,
    segs,
  };
}

/* ---------------- one switch, hop by hop (the trace panel) ---------------- */

export interface Hop { who: "hw" | "os"; title: string; note: string; mode: "user" | "kernel"; running: "A" | "B" }
export const HOPS: Hop[] = [
  { who: "hw", mode: "user", running: "A", title: "A runs directly on the CPU", note: "User mode, full speed. The kernel is not running at all." },
  { who: "hw", mode: "kernel", running: "A", title: "Timer interrupt: trap", note: "The CPU saves A's user registers (PC, flags, stack pointer) on A's kernel stack, switches to kernel mode and jumps to the handler the kernel listed in its trap table at boot." },
  { who: "os", mode: "kernel", running: "A", title: "Scheduler decides", note: "The handler asks the scheduler: keep A, or run someone else? B is ready, so switch." },
  { who: "os", mode: "kernel", running: "B", title: "switch(): save A, load B", note: "The kernel saves A's kernel registers into A's process structure, loads B's, and points the stack pointer at B's kernel stack." },
  { who: "hw", mode: "user", running: "B", title: "Return from trap into B", note: "The CPU pops B's user registers off B's kernel stack, drops to user mode and resumes B where it last stopped. Its caches are cold." },
];

/* ---------------- state + step ---------------- */

export interface State {
  timer: Timer;
  batch: BatchMode;
  last: RunResult | null;
  runs: RunResult[];
  guess: Guess | null;
  hop: number;
}

export type Action =
  | { type: "timer"; timer: Timer }
  | { type: "batch"; batch: BatchMode }
  | { type: "run" }
  | { type: "guess"; guess: Guess }
  | { type: "hop" }
  | { type: "reset" };

export function init(): State {
  return { timer: 10000, batch: "loops", last: null, runs: [], guess: null, hop: 0 };
}

const key = (r: { timer: Timer; batch: BatchMode }) => `${r.timer}:${r.batch}`;

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "timer": return { ...s, timer: a.timer, last: null };
    case "batch": return { ...s, batch: a.batch, last: null };
    case "guess": return s.runs.some((r) => r.timer === null && r.batch === "loops") ? s : { ...s, guess: a.guess };
    case "hop": return { ...s, hop: (s.hop + 1) % HOPS.length };
    case "run": {
      const r = simulate(s.timer, s.batch);
      const runs = [...s.runs.filter((x) => key(x) !== key(r)), r].slice(-8);
      return { ...s, last: r, runs };
    }
  }
}

/** The reader's own comparison: shortest and longest timer they tried, and whether they ran with no timer. */
export function summary(runs: RunResult[]) {
  const timed = runs.filter((r) => r.timer !== null);
  if (timed.length < 2) return null;
  const short = timed.reduce((a, b) => ((a.timer as number) <= (b.timer as number) ? a : b));
  const long = timed.reduce((a, b) => ((a.timer as number) >= (b.timer as number) ? a : b));
  if (short === long) return null;
  const best = timed.filter((r) => r.worstMs !== null).reduce<RunResult | null>((a, b) => (a === null || (b.worstMs as number) < (a.worstMs as number) ? b : a), null);
  const stuck = runs.find((r) => r.timer === null && r.batch === "loops") ?? null;
  return { short, long, best, stuck };
}
