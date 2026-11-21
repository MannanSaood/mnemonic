// Interleave it: two request threads each run `calls = calls + 1` once on a shared usage meter.
// The reader plays the scheduler: step either thread by hand, replay any of the 20 possible
// orders, or let a scheduler run 1,000 schedules. Then add a lock or an atomic add.
//
// Purpose. After this, the reader can answer: "Why does `calls++` lose updates, and why did my
// tests never catch it?" The increment is three steps: read, add, write. Of the 20 ways two
// threads' six steps can interleave, 18 lose one of the two counts; only the 2 serial orders are
// right. A scheduler that switches threads rarely (time slices) almost always picks a serial
// order, so tests pass. A lock or an atomic add removes the 18 bad orders entirely.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Mode = "plain" | "lock" | "atomic";
export type Tid = "A" | "B";
export const TIDS: Tid[] = ["A", "B"];
export type Op = "lock" | "read" | "add" | "write" | "unlock" | "atomic";

export const PROGRAMS: Record<Mode, Op[]> = {
  plain: ["read", "add", "write"],
  lock: ["lock", "read", "add", "write", "unlock"],
  atomic: ["atomic"],
};

/** The source line each op stands for, per mode. */
export const LINES: Record<Op, string> = {
  lock: "mu.lock()",
  read: "tmp = calls",
  add: "tmp = tmp + 1",
  write: "calls = tmp",
  unlock: "mu.unlock()",
  atomic: "calls.add(1)",
};

/** The meter already counted 41 calls; each run adds two more requests. */
export const START = 41;
/** Runs per scheduler batch. */
export const BATCH = 1000;
/** Time-slice scheduler: chance of switching threads after any step. */
export const P_SWITCH = 0.01;

export interface Thread { pc: number; reg: number | null; /** the value of calls this thread read */ saw: number | null }
export interface Step { id: number; t: Tid; op: Op; text: string; bad: boolean }
export type Sched = "slices" | "coin";
export interface Batch { mode: Mode; sched: Sched; runs: number; lost: number; billed: number; served: number }
export type Guess = "all" | "half" | "two";

export interface State {
  mode: Mode;
  calls: number;
  th: Record<Tid, Thread>;
  holder: Tid | null;
  trace: Step[];
  /** The order of the six core steps (read, add, write per thread) so far, as letters: "AABBAB". */
  order: string;
  /** Orders the reader has played to the end, with the final value of calls. */
  seen: Record<string, number>;
  hand: { runs: number; lost: number };
  batches: Batch[];
  seed: number;
  guess: Guess | null;
  showAll: boolean;
  /** One-line explanation of the last thing that happened. */
  note: string;
  seq: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "mode"; mode: Mode }
  | { type: "step"; t: Tid }
  | { type: "again" }
  | { type: "replay"; order: string }
  | { type: "batch"; sched: Sched }
  | { type: "showAll" }
  | { type: "reset" };

const fresh = (): Record<Tid, Thread> => ({ A: { pc: 0, reg: null, saw: null }, B: { pc: 0, reg: null, saw: null } });

export function init(): State {
  return {
    mode: "plain", calls: START, th: fresh(), holder: null, trace: [], order: "", seen: {},
    hand: { runs: 0, lost: 0 }, batches: [], seed: 7, guess: null, showAll: false,
    note: "Two requests arrive at once. Each must add 1 to calls. Step A or B to choose who runs next.", seq: 0,
  };
}

/* ---------------- the threads ---------------- */

const other = (t: Tid): Tid => (t === "A" ? "B" : "A");
export const nextOp = (s: State, t: Tid): Op | null => PROGRAMS[s.mode][s.th[t].pc] ?? null;
export const finished = (s: State) => TIDS.every((t) => nextOp(s, t) === null);

/** Can thread t take a step now? Not when done, and not when it would wait for a lock another thread holds. */
export function canStep(s: State, t: Tid): boolean {
  const op = nextOp(s, t);
  if (op === null) return false;
  return !(op === "lock" && s.holder !== null && s.holder !== t);
}

function clone(s: State): State {
  return { ...s, th: { A: { ...s.th.A }, B: { ...s.th.B } }, trace: [...s.trace], seen: { ...s.seen }, hand: { ...s.hand }, batches: [...s.batches] };
}

/** Run one step of thread t in place. Assumes canStep. */
function exec(s: State, t: Tid) {
  const th = s.th[t];
  const op = PROGRAMS[s.mode][th.pc];
  let text = "";
  let bad = false;
  switch (op) {
    case "lock":
      s.holder = t;
      text = `${t} took the lock`;
      break;
    case "read":
      th.reg = s.calls;
      th.saw = s.calls;
      s.order += t;
      text = `${t} read ${s.calls}`;
      break;
    case "add":
      th.reg = (th.reg ?? 0) + 1;
      s.order += t;
      text = `${t} added 1 → ${th.reg}`;
      break;
    case "write": {
      bad = s.calls !== th.saw;
      const was = s.calls;
      s.calls = th.reg ?? 0;
      s.order += t;
      text = bad ? `${t} wrote ${s.calls} over ${was}: ${other(t)}'s count is gone` : `${t} wrote ${s.calls}`;
      break;
    }
    case "unlock":
      s.holder = null;
      text = `${t} released the lock`;
      break;
    case "atomic":
      th.saw = s.calls;
      s.calls += 1;
      th.reg = s.calls;
      s.order += t + t + t;
      text = `${t} added 1 in one step → ${s.calls}`;
      break;
  }
  th.pc++;
  s.seq++;
  s.trace.push({ id: s.seq, t, op, text, bad });
}

/** When both threads are done, record the run. */
function settle(s: State) {
  if (!finished(s)) return;
  const lost = s.calls !== START + 2;
  s.seen[s.order] = s.calls;
  s.hand.runs++;
  if (lost) s.hand.lost++;
  s.note = lost
    ? `Two requests served, calls went from ${START} to ${s.calls}. One count was lost: both threads read ${START} before either wrote.`
    : `Two requests served, calls is ${s.calls}. Right, because one thread finished its write before the other read.`;
}

function newRun(s: State) {
  s.calls = START;
  s.th = fresh();
  s.holder = null;
  s.trace = [];
  s.order = "";
}

/* ---------------- orders ---------------- */

/** All 20 orders of the six core steps: three A's and three B's. */
export const ORDERS: string[] = (() => {
  const out: string[] = [];
  const rec = (pre: string, a: number, b: number) => {
    if (a === 0 && b === 0) { out.push(pre); return; }
    if (a > 0) rec(pre + "A", a - 1, b);
    if (b > 0) rec(pre + "B", a, b - 1);
  };
  rec("", 3, 3);
  return out;
})();

/**
 * Play a whole order of core steps from a fresh run. Lock and unlock steps run when needed.
 * Returns null if the order cannot happen in this mode (a thread would have to pass a held lock,
 * or an atomic add would have to be split).
 */
export function play(s0: State, order: string): State | null {
  const s = clone(s0);
  newRun(s);
  let i = 0;
  while (i < order.length) {
    const t = order[i] as Tid;
    if (s.mode === "atomic") {
      if (order.slice(i, i + 3) !== t + t + t || !canStep(s, t)) return null;
      exec(s, t);
      i += 3;
      continue;
    }
    // run t up to and including its next core step
    for (;;) {
      if (!canStep(s, t)) return null;
      const op = nextOp(s, t)!;
      exec(s, t);
      if (op !== "lock" && op !== "unlock") break;
    }
    i++;
    // a thread that has finished its core steps releases the lock straight away
    if (nextOp(s, t) === "unlock") exec(s, t);
  }
  return finished(s) ? s : null;
}

/** The final value of calls for every order in plain mode: what the 20 interleavings do. */
export function outcomes(mode: Mode = "plain"): { order: string; calls: number | null }[] {
  const base = { ...init(), mode };
  return ORDERS.map((order) => ({ order, calls: play(base, order)?.calls ?? null }));
}

/* ---------------- schedulers ---------------- */

/** mulberry32: a small seeded PRNG, so batches are repeatable. */
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

/** Run `runs` schedules with the given scheduler and count lost updates. Pure. */
export function simulate(mode: Mode, sched: Sched, runs: number, seed: number): Batch {
  const r = rng(seed);
  let lost = 0;
  for (let k = 0; k < runs; k++) {
    const s: State = { ...init(), mode };
    let cur: Tid = r() < 0.5 ? "A" : "B";
    while (!finished(s)) {
      let pick: Tid;
      if (sched === "coin") {
        const ok = TIDS.filter((t) => canStep(s, t));
        pick = ok.length === 2 ? (r() < 0.5 ? "A" : "B") : ok[0];
      } else {
        if (!canStep(s, cur)) cur = other(cur);
        else if (canStep(s, other(cur)) && r() < P_SWITCH) cur = other(cur);
        pick = cur;
      }
      exec(s, pick);
    }
    if (s.calls !== START + 2) lost++;
  }
  return { mode, sched, runs, lost, served: runs * 2, billed: runs * 2 - lost };
}

/* ---------------- step ---------------- */

export const ANSWER: Guess = "two";

/** The predict question is answered once the reader has seen a lost update or all 20 orders. */
export const revealed = (s: State) => s.showAll || s.hand.lost > 0;

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return revealed(st) ? st : { ...st, guess: a.guess };
    case "mode": {
      if (a.mode === st.mode) return st;
      const s = clone(st);
      s.mode = a.mode;
      newRun(s);
      s.note = a.mode === "plain"
        ? "No protection: read, add and write are three separate steps."
        : a.mode === "lock"
          ? "Each thread now takes a lock before it reads and releases it after it writes. Try to get both reads in before a write."
          : "Each thread now does calls.add(1): one indivisible step. Try to split it.";
      return s;
    }
    case "step": {
      if (!canStep(st, a.t)) return st;
      const s = clone(st);
      exec(s, a.t);
      const last = s.trace[s.trace.length - 1];
      s.note = last.bad
        ? `${last.text}. ${a.t} computed its value from a stale read.`
        : canStep(s, other(a.t)) || finished(s)
          ? `${last.text}.`
          : `${last.text}. ${other(a.t)} ${nextOp(s, other(a.t)) === "lock" ? "has to wait for the lock" : "is done"}.`;
      settle(s);
      return s;
    }
    case "again": {
      const s = clone(st);
      newRun(s);
      s.note = "A new pair of requests. calls is back to 41 for this run; your totals are kept.";
      return s;
    }
    case "replay": {
      if (!ORDERS.includes(a.order)) return st;
      const s = play(st, a.order);
      if (!s) {
        const c = clone(st);
        newRun(c);
        c.note = st.mode === "lock"
          ? `Order ${a.order} cannot happen with the lock: the second thread waits at mu.lock() until the first has written and unlocked.`
          : `Order ${a.order} cannot happen with an atomic add: read, add and write are one step that nothing can come between.`;
        return c;
      }
      settle(s);
      return s;
    }
    case "batch": {
      const s = clone(st);
      const b = simulate(st.mode, a.sched, BATCH, st.seed);
      s.seed = (st.seed * 31 + 17) >>> 0;
      s.batches = [...s.batches, b].slice(-6);
      s.note = `${BATCH} schedules, ${a.sched === "coin" ? "a coin flip before every step" : "threads switched rarely, like time slices"}: ${b.lost} lost an update.`;
      return s;
    }
    case "showAll":
      return { ...st, showAll: true };
  }
}
