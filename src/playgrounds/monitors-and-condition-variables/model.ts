// Bounded buffer by hand: one producer (P1) and two consumers (C1, C2) share a job queue of
// capacity 1, guarded by one lock and one condition variable, as in Python's
// threading.Condition or a Java monitor. The reader steps each thread one line at a time,
// switches the guard around wait() between `if` and `while`, and the wake between signal (wake
// one) and broadcast (wake all), and can wake a waiting thread spuriously.
//
// Purpose. After this, the reader can answer: "Why must wait() sit in a while loop, and when is
// signal not enough?" A woken thread does not run at once: it must get the lock back, and by then
// another thread may have taken the job (or nothing happened at all: a spurious wakeup). With `if`
// it carries on and takes from an empty queue. With `while` it rechecks and waits again. And with
// one condition variable shared by producers and consumers, signal can wake the wrong kind of
// thread: a consumer wakes a consumer, the producer is never told, and all three sleep forever
// (a lost wakeup). Broadcast, or a separate condition per predicate, fixes that.
//
// The wait set is FIFO, as in CPython's Condition: signal wakes the thread that has waited longest.
// Plain state + a pure step function, so it can be tested without a browser.

export type Tid = "P1" | "C1" | "C2";
export const TIDS: Tid[] = ["P1", "C1", "C2"];
export type Role = "prod" | "cons";
export const ROLE: Record<Tid, Role> = { P1: "prod", C1: "cons", C2: "cons" };
export type Guard = "if" | "while";
export type Wake = "signal" | "broadcast";
export type Status = "ready" | "waiting" | "woken" | "crashed";
export const CAP = 1;
export const BATCH = 1000;
export const BATCH_STEPS = 60;
export const P_SPURIOUS = 0.02;

/** pc: 0 lock · 1 check and maybe wait · 2 put or take · 3 signal or broadcast · 4 unlock */
export interface Thread { pc: number; status: Status; done: number; recheck: boolean }
export interface Stats { produced: number; consumed: number; wakeups: number; useless: number; spurious: number; crashes: number; overflows: number; stalls: number }
export interface Batch { guard: Guard; wake: Wake; runs: number; crashed: number; stalled: number; ok: number; useless: number }
export type ChallengeId = "crash" | "spurious" | "stall" | "clean";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "crash", text: "With if, make a consumer take from an empty queue." },
  { id: "spurious", text: "Wake a waiting thread spuriously, with no signal at all." },
  { id: "stall", text: "With while and signal, get all three threads asleep for good." },
  { id: "clean", text: "Find the guard and wake that pass 1,000 random schedules with no bug." },
];
export type Guess = "waits" | "crash" | "gets";
export interface Ev { id: number; ok: boolean; text: string; path: string[] }

export interface State {
  guard: Guard;
  wake: Wake;
  th: Record<Tid, Thread>;
  holder: Tid | null;
  queue: number[];
  waitSet: Tid[];
  nextJob: number;
  stalled: boolean;
  stats: Stats;
  done: ChallengeId[];
  batches: Batch[];
  seed: number;
  guess: Guess | null;
  log: Ev[];
  seq: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "guard"; guard: Guard }
  | { type: "wake"; wake: Wake }
  | { type: "step"; t: Tid }
  | { type: "spurious"; t: Tid }
  | { type: "batch" }
  | { type: "restart" }
  | { type: "reset" };

const thread = (): Thread => ({ pc: 0, status: "ready", done: 0, recheck: false });
const zero = (): Stats => ({ produced: 0, consumed: 0, wakeups: 0, useless: 0, spurious: 0, crashes: 0, overflows: 0, stalls: 0 });

export function init(): State {
  return {
    guard: "if", wake: "signal", th: { P1: thread(), C1: thread(), C2: thread() }, holder: null, queue: [], waitSet: [],
    nextJob: 1, stalled: false, stats: zero(), done: [], batches: [], seed: 5, guess: null, log: [], seq: 0,
  };
}

/** The source lines each thread shows, for the current guard and wake. */
export function lines(s: Pick<State, "guard" | "wake">, t: Tid): string[] {
  const cv = s.wake === "signal" ? "cv.signal()" : "cv.broadcast()";
  return ROLE[t] === "prod"
    ? ["mu.lock()", `${s.guard} queue.full(): cv.wait()`, "queue.put(job)", cv, "mu.unlock()"]
    : ["mu.lock()", `${s.guard} queue.empty(): cv.wait()`, "job = queue.take()", cv, "mu.unlock()"];
}

/* ---------------- the threads ---------------- */

export function canStep(s: State, t: Tid): boolean {
  const th = s.th[t];
  if (th.status === "crashed" || th.status === "waiting") return false;
  if (th.status === "woken") return s.holder === null;
  if (th.pc === 0) return s.holder === null;
  return true;
}

const mustWait = (s: State, t: Tid) => (ROLE[t] === "prod" ? s.queue.length >= CAP : s.queue.length === 0);

function clone(s: State): State {
  return {
    ...s, th: { P1: { ...s.th.P1 }, C1: { ...s.th.C1 }, C2: { ...s.th.C2 } }, queue: [...s.queue], waitSet: [...s.waitSet],
    stats: { ...s.stats }, done: [...s.done], batches: [...s.batches], log: [...s.log],
  };
}

function log(s: State | null, e: Omit<Ev, "id">) {
  if (!s) return;
  s.seq++;
  s.log = [{ ...e, id: s.seq }, ...s.log].slice(0, 7);
}

function achieve(s: State, c: ChallengeId) {
  if (!s.done.includes(c)) s.done.push(c);
}

/** One line of thread t, in place. `quiet` skips the log (used by the batch runner). */
function exec(s: State, t: Tid, quiet = false) {
  const th = s.th[t];
  const L = quiet ? null : s;
  if (th.status === "woken") {
    s.holder = t;
    th.status = "ready";
    th.pc = s.guard === "if" ? 2 : 1;
    th.recheck = s.guard === "while";
    log(L, {
      ok: true, path: [t, "wake", "mu.lock()", s.guard === "if" ? "skip the check" : "check again"],
      text: s.guard === "if"
        ? `${t} got the lock back. With if, wait() returning means "go on", so it heads straight for the queue without looking.`
        : `${t} got the lock back. With while, it loops round and checks the queue again before going on.`,
    });
    return;
  }
  const prod = ROLE[t] === "prod";
  switch (th.pc) {
    case 0:
      s.holder = t;
      th.pc = 1;
      log(L, { ok: true, path: [t, "mu.lock()"], text: `${t} took the lock.` });
      return;
    case 1:
      if (mustWait(s, t)) {
        s.waitSet.push(t);
        th.status = "waiting";
        s.holder = null;
        if (th.recheck) s.stats.useless++;
        log(L, {
          ok: !th.recheck, path: [t, prod ? "queue full" : "queue empty", "cv.wait()", "unlock + sleep"],
          text: th.recheck
            ? `${t} was woken for nothing: the queue is still ${prod ? "full" : "empty"}, so it waits again. The while loop caught it.`
            : `The queue is ${prod ? "full" : "empty"}. ${t} waits: it releases the lock and joins the wait set, all in one step.`,
        });
      } else {
        th.pc = 2;
        log(L, { ok: true, path: [t, prod ? "not full" : "not empty", "go on"], text: `The queue is ${prod ? "not full" : "not empty"}, so ${t} goes on.` });
      }
      th.recheck = false;
      return;
    case 2:
      if (prod) {
        const job = s.nextJob++;
        s.queue.push(job);
        s.stats.produced++;
        if (s.queue.length > CAP) {
          s.stats.overflows++;
          achieve(s, "crash");
          log(L, { ok: false, path: [t, `put #${job}`, `${s.queue.length} of ${CAP}`], text: `${t} put job #${job} into a full queue. The bounded queue now holds ${s.queue.length} of ${CAP}: its one rule is broken.` });
        } else {
          log(L, { ok: true, path: [t, `put #${job}`], text: `${t} put job #${job} in the queue.` });
        }
      } else if (s.queue.length === 0) {
        th.status = "crashed";
        s.holder = null;
        s.stats.crashes++;
        achieve(s, "crash");
        log(L, { ok: false, path: [t, "take()", "queue empty", "crash"], text: `${t} took from an empty queue and crashed (an IndexError or a panic). It was woken, but someone else got the job first, and if never looked again.` });
        return;
      } else {
        const job = s.queue.shift()!;
        s.stats.consumed++;
        log(L, { ok: true, path: [t, `take #${job}`], text: `${t} took job #${job}.` });
      }
      th.pc = 3;
      return;
    case 3: {
      const woke = s.wake === "signal" ? s.waitSet.splice(0, 1) : s.waitSet.splice(0);
      for (const w of woke) s.th[w].status = "woken";
      s.stats.wakeups += woke.length;
      th.pc = 4;
      log(L, {
        ok: true, path: [t, s.wake === "signal" ? "cv.signal()" : "cv.broadcast()", woke.length ? `wake ${woke.join(", ")}` : "nobody waiting"],
        text: woke.length === 0
          ? `${t} ${s.wake === "signal" ? "signalled" : "broadcast"}, but nobody was waiting. The wake-up is not stored anywhere.`
          : `${t} woke ${woke.join(" and ")}. ${woke.length > 1 ? "They are" : "It is"} runnable but must get the lock back before ${woke.length > 1 ? "they" : "it"} can go on.`,
      });
      return;
    }
    case 4:
      s.holder = null;
      th.pc = 0;
      th.done++;
      log(L, { ok: true, path: [t, "mu.unlock()"], text: `${t} released the lock and starts its loop again.` });
      return;
  }
}

/** Everyone left is asleep in the wait set: nothing can ever wake them. */
export const isStalled = (s: State) => !TIDS.some((t) => canStep(s, t)) && TIDS.some((t) => s.th[t].status === "waiting");

function settle(s: State) {
  if (!s.stalled && isStalled(s)) {
    s.stalled = true;
    s.stats.stalls++;
    if (s.guard === "while" && s.wake === "signal") achieve(s, "stall");
    const asleep = TIDS.filter((t) => s.th[t].status === "waiting");
    log(s, {
      ok: false, path: [...asleep.map((t) => `${t} asleep`), "nobody left to signal"],
      text: `Everyone is asleep${s.queue.length ? `, with job #${s.queue[0]} still in the queue` : ""}. The last signal woke a thread that could not use it, and nobody is left to signal the one that could: a lost wakeup.`,
    });
  }
}

function wakeSpuriously(s: State, t: Tid, quiet = false) {
  s.waitSet = s.waitSet.filter((w) => w !== t);
  s.th[t].status = "woken";
  s.stats.spurious++;
  achieve(s, "spurious");
  log(quiet ? null : s, { ok: false, path: [t, "spurious wakeup", "no signal"], text: `${t} woke up with no signal at all. Condition variables are allowed to do this, so the code must cope.` });
}

/* ---------------- batch runner ---------------- */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random schedules: each step a random runnable thread runs a line; now and then a waiter wakes spuriously. */
export function simulate(guard: Guard, wake: Wake, runs = BATCH, seed = 5, steps = BATCH_STEPS): Batch {
  const r = rng(seed);
  let crashed = 0, stalled = 0, ok = 0, useless = 0;
  for (let k = 0; k < runs; k++) {
    const s: State = { ...init(), guard, wake };
    let end: "ok" | "crash" | "stall" = "ok";
    for (let i = 0; i < steps; i++) {
      const waiting = TIDS.filter((t) => s.th[t].status === "waiting");
      if (waiting.length && r() < P_SPURIOUS) wakeSpuriously(s, waiting[Math.floor(r() * waiting.length)], true);
      const ready = TIDS.filter((t) => canStep(s, t));
      if (!ready.length) { end = "stall"; break; }
      exec(s, ready[Math.floor(r() * ready.length)], true);
      if (s.stats.crashes || s.stats.overflows) { end = "crash"; break; }
    }
    useless += s.stats.useless;
    if (end === "crash") crashed++; else if (end === "stall") stalled++; else ok++;
  }
  return { guard, wake, runs, crashed, stalled, ok, useless };
}

/* ---------------- step ---------------- */

export const ANSWER: Guess = "crash";
export const revealed = (s: State) => s.stats.crashes + s.stats.overflows > 0 || s.batches.length > 0;

function restart(s: State) {
  s.th = { P1: thread(), C1: thread(), C2: thread() };
  s.holder = null;
  s.queue = [];
  s.waitSet = [];
  s.stalled = false;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return revealed(st) ? st : { ...st, guess: a.guess };
    case "guard":
    case "wake": {
      const s = clone(st);
      if (a.type === "guard") { if (a.guard === st.guard) return st; s.guard = a.guard; }
      else { if (a.wake === st.wake) return st; s.wake = a.wake; }
      restart(s);
      log(s, { ok: true, path: ["new code", `${s.guard} + ${s.wake}`], text: `New code: ${s.guard} around wait(), ${s.wake === "signal" ? "signal wakes one waiter" : "broadcast wakes every waiter"}. All three threads start from the top.` });
      return s;
    }
    case "step": {
      if (!canStep(st, a.t)) return st;
      const s = clone(st);
      exec(s, a.t);
      settle(s);
      return s;
    }
    case "spurious": {
      if (st.th[a.t].status !== "waiting") return st;
      const s = clone(st);
      wakeSpuriously(s, a.t);
      s.stalled = false;
      return s;
    }
    case "batch": {
      const s = clone(st);
      const b = simulate(st.guard, st.wake, BATCH, st.seed);
      s.seed = (st.seed * 31 + 7) >>> 0;
      s.batches = [...s.batches.filter((x) => !(x.guard === b.guard && x.wake === b.wake)), b];
      if (b.crashed === 0 && b.stalled === 0) achieve(s, "clean");
      return s;
    }
    case "restart": {
      const s = clone(st);
      restart(s);
      log(s, { ok: true, path: ["restart"], text: "All three threads start from the top with an empty queue. Your totals are kept." });
      return s;
    }
  }
}
