// Wait-for graph: two threads move money between two accounts, each account guarded by its own
// lock. T1 runs transfer(A → B) and T2 runs transfer(B → A), over and over. The reader steps
// either thread by hand or ticks both cores at once, and watches the wait-for graph.
//
// Purpose. After this, the reader can answer: "Why do these two transfers hang forever, and
// which fix stops it?" Locking `from` then `to` means the two threads take the same two locks in
// opposite orders. If each gets its first lock, each waits for the other's: a cycle in the
// wait-for graph, and nothing can ever break it. Locking in one global order (lowest account id
// first) makes the cycle impossible. Try-lock with backoff breaks it by giving the lock back, but
// two threads that back off for the same time retry in lockstep forever: livelock. Random jitter
// in the backoff ends it.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Tid = "T1" | "T2";
export const TIDS: Tid[] = ["T1", "T2"];
export type Acct = "A" | "B";
export type Mode = "naive" | "ordered" | "trylock";

/** Each thread's transfer: from, to and amount. */
export const JOBS: Record<Tid, { from: Acct; to: Acct; amount: number }> = {
  T1: { from: "A", to: "B", amount: 50 },
  T2: { from: "B", to: "A", amount: 30 },
};
export const ID: Record<Acct, number> = { A: 1, B: 2 };
export const OPENING = 500;
/** Backoff in ticks without jitter. With jitter it is 1..JITTER_MAX. */
export const BACKOFF = 2;
export const JITTER_MAX = 4;
/** Ticks per scripted run. */
export const RUN_TICKS = 40;
/** No transfer for this many ticks while retrying counts as livelock. */
export const LIVELOCK_TICKS = 12;

/**
 * Program counters.
 * naive / ordered: 0 lock first · 1 lock second · 2 move · 3 unlock second · 4 unlock first
 * trylock:         0 lock from · 1 tryLock to · 2 unlock from + back off · 3 move · 4 unlock to · 5 unlock from
 */
export interface Thread { pc: number; sleep: number; transfers: number; retries: number; waited: number }
export interface RunRow { mode: Mode; jitter: boolean; ticks: number; transfers: number; retries: number; deadlocked: boolean; livelocked: boolean }
export type Guess = "serial" | "error" | "forever";
export interface Ev { id: number; ok: boolean; text: string; path: string[] }

export interface State {
  mode: Mode;
  jitter: boolean;
  th: Record<Tid, Thread>;
  holder: Record<Acct, Tid | null>;
  balance: Record<Acct, number>;
  ticks: number;
  lastProgress: number;
  seed: number;
  rows: RunRow[];
  deadlocks: number;
  guess: Guess | null;
  log: Ev[];
  seq: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "mode"; mode: Mode }
  | { type: "jitter"; on: boolean }
  | { type: "step"; t: Tid }
  | { type: "tick" }
  | { type: "run" }
  | { type: "restart" }
  | { type: "reset" };

const thread = (): Thread => ({ pc: 0, sleep: 0, transfers: 0, retries: 0, waited: 0 });

export function init(): State {
  return {
    mode: "naive", jitter: false, th: { T1: thread(), T2: thread() }, holder: { A: null, B: null },
    balance: { A: OPENING, B: OPENING }, ticks: 0, lastProgress: 0, seed: 2, rows: [], deadlocks: 0,
    guess: null, log: [], seq: 0,
  };
}

/* ---------------- programs ---------------- */

const other = (t: Tid): Tid => (t === "T1" ? "T2" : "T1");

/** The account a thread locks first and second under the current mode. */
export function lockOrder(mode: Mode, t: Tid): [Acct, Acct] {
  const { from, to } = JOBS[t];
  if (mode === "ordered") return ID[from] < ID[to] ? [from, to] : [to, from];
  return [from, to];
}

/** Source lines per mode, as the threads show them. */
export function lines(mode: Mode, t: Tid): string[] {
  const { from, to, amount } = JOBS[t];
  const [first, second] = lockOrder(mode, t);
  if (mode === "trylock") {
    return [`${from}.lock()`, `if !${to}.tryLock() {`, `  ${from}.unlock(); sleep; retry }`, `move ${amount}: ${from} → ${to}`, `${to}.unlock()`, `${from}.unlock()`];
  }
  return [`${first}.lock()`, `${second}.lock()`, `move ${amount}: ${from} → ${to}`, `${second}.unlock()`, `${first}.unlock()`];
}

/** The lock thread t is blocked on right now, if any. */
export function waitingFor(s: State, t: Tid): Acct | null {
  const th = s.th[t];
  if (th.sleep > 0) return null;
  let want: Acct | null = null;
  if (s.mode === "trylock") want = th.pc === 0 ? JOBS[t].from : null; // tryLock never blocks
  else if (th.pc === 0 || th.pc === 1) want = lockOrder(s.mode, t)[th.pc];
  if (!want) return null;
  const h = s.holder[want];
  return h !== null && h !== t ? want : null;
}

export const held = (s: State, t: Tid): Acct[] => (["A", "B"] as Acct[]).filter((a) => s.holder[a] === t);

/** A cycle in the wait-for graph: each thread waits for a lock the other holds. */
export function deadlocked(s: State): boolean {
  const a = waitingFor(s, "T1"), b = waitingFor(s, "T2");
  return a !== null && b !== null && s.holder[a] === "T2" && s.holder[b] === "T1";
}

export function livelocked(s: State): boolean {
  return s.mode === "trylock" && s.ticks - s.lastProgress >= LIVELOCK_TICKS && TIDS.every((t) => s.th[t].retries >= 2);
}

export const canStep = (s: State, t: Tid) => waitingFor(s, t) === null;

/* ---------------- helpers ---------------- */

function clone(s: State): State {
  return {
    ...s, th: { T1: { ...s.th.T1 }, T2: { ...s.th.T2 } }, holder: { ...s.holder }, balance: { ...s.balance },
    rows: [...s.rows], log: [...s.log],
  };
}

function log(s: State, e: Omit<Ev, "id">) {
  s.seq++;
  s.log = [{ ...e, id: s.seq }, ...s.log].slice(0, 6);
}

/** mulberry32, one draw: returns [value in 0..1, next seed]. */
function draw(seed: number): [number, number] {
  const a = (seed + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

/** Run one step of thread t in place. A blocked thread just waits. */
function exec(s: State, t: Tid) {
  const th = s.th[t];
  if (waitingFor(s, t)) { th.waited++; return; }
  if (th.sleep > 0) {
    th.sleep--;
    if (th.sleep === 0) th.pc = 0;
    return;
  }
  if (s.mode === "trylock") {
    const { from, to } = JOBS[t];
    switch (th.pc) {
      case 0: s.holder[from] = t; th.pc = 1; log(s, { ok: true, text: `${t} locked ${from}.`, path: [t, `${from}.lock()`, "held"] }); return;
      case 1:
        if (s.holder[to] === null) { s.holder[to] = t; th.pc = 3; log(s, { ok: true, text: `${t} got ${to} with tryLock.`, path: [t, `${to}.tryLock()`, "true"] }); }
        else { th.pc = 2; log(s, { ok: false, text: `${t} tried ${to}, but ${s.holder[to]} holds it. ${t} will give ${from} back.`, path: [t, `${to}.tryLock()`, "false"] }); }
        return;
      case 2: {
        s.holder[from] = null;
        th.retries++;
        let n = BACKOFF;
        if (s.jitter) { const [r, next] = draw(s.seed); s.seed = next; n = 1 + Math.floor(r * JITTER_MAX); }
        th.sleep = n;
        log(s, { ok: false, text: `${t} released ${from} and backs off ${n} tick${n === 1 ? "" : "s"}${s.jitter ? " (random)" : ""} before retrying.`, path: [t, `${from}.unlock()`, `sleep ${n}`, "retry"] });
        return;
      }
      case 3: move(s, t); th.pc = 4; return;
      case 4: s.holder[to] = null; th.pc = 5; return;
      case 5: s.holder[from] = null; th.pc = 0; done(s, t); return;
    }
    return;
  }
  const [first, second] = lockOrder(s.mode, t);
  switch (th.pc) {
    case 0: s.holder[first] = t; th.pc = 1; log(s, { ok: true, text: `${t} locked ${first}.`, path: [t, `${first}.lock()`, "held"] }); return;
    case 1: s.holder[second] = t; th.pc = 2; log(s, { ok: true, text: `${t} locked ${second}. It holds both.`, path: [t, `${second}.lock()`, "held"] }); return;
    case 2: move(s, t); th.pc = 3; return;
    case 3: s.holder[second] = null; th.pc = 4; return;
    case 4: s.holder[first] = null; th.pc = 0; done(s, t); return;
  }
}

function move(s: State, t: Tid) {
  const { from, to, amount } = JOBS[t];
  s.balance[from] -= amount;
  s.balance[to] += amount;
}

function done(s: State, t: Tid) {
  s.th[t].transfers++;
  s.lastProgress = s.ticks;
  const { from, to, amount } = JOBS[t];
  log(s, { ok: true, text: `${t} moved ${amount} from ${from} to ${to} and released both locks.`, path: [t, "move", "unlock", "done"] });
}

/** After any step: notice a new deadlock. */
function check(s: State, was: boolean) {
  if (!was && deadlocked(s)) {
    s.deadlocks++;
    const [a, b] = [waitingFor(s, "T1")!, waitingFor(s, "T2")!];
    log(s, {
      ok: false, text: `Deadlock. T1 holds ${b} and waits for ${a}; T2 holds ${a} and waits for ${b}. Neither will ever let go.`,
      path: ["T1", `→ ${a}`, "T2", `→ ${b}`, "T1"],
    });
  }
}

function restartRun(s: State) {
  s.th = { T1: thread(), T2: thread() };
  s.holder = { A: null, B: null };
  s.ticks = 0;
  s.lastProgress = 0;
}

/** One tick: both cores run one step of their thread. T1 goes first within the tick. */
function tick(s: State) {
  const was = deadlocked(s);
  s.ticks++;
  for (const t of TIDS) exec(s, t);
  check(s, was);
}

/** A scripted run from a fresh start, both cores in lockstep. Pure. */
export function simulate(mode: Mode, jitter: boolean, ticks = RUN_TICKS, seed = 2): RunRow {
  const s: State = { ...init(), mode, jitter, seed };
  for (let i = 0; i < ticks; i++) tick(s);
  return {
    mode, jitter, ticks,
    transfers: s.th.T1.transfers + s.th.T2.transfers,
    retries: s.th.T1.retries + s.th.T2.retries,
    deadlocked: deadlocked(s), livelocked: livelocked(s),
  };
}

/* ---------------- step ---------------- */

export const ANSWER: Guess = "forever";
export const revealed = (s: State) => s.deadlocks > 0 || s.rows.some((r) => r.mode === "naive");

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
      restartRun(s);
      log(s, { ok: true, text: a.mode === "naive" ? "Each transfer locks its from account, then its to account." : a.mode === "ordered" ? "Each transfer locks the account with the lower id first, whichever way the money goes." : "Each transfer locks from, then tries to; if to is taken, it gives from back and retries later.", path: ["new code"] });
      return s;
    }
    case "jitter": {
      const s = clone(st);
      s.jitter = a.on;
      return s;
    }
    case "step": {
      if (!canStep(st, a.t)) return st;
      const s = clone(st);
      const was = deadlocked(s);
      exec(s, a.t);
      check(s, was);
      return s;
    }
    case "tick": {
      const s = clone(st);
      tick(s);
      return s;
    }
    case "run": {
      const s = clone(st);
      restartRun(s);
      const was = s.deadlocks;
      for (let i = 0; i < RUN_TICKS; i++) tick(s);
      s.deadlocks = was + (deadlocked(s) ? 1 : 0);
      const row: RunRow = {
        mode: s.mode, jitter: s.jitter, ticks: RUN_TICKS,
        transfers: s.th.T1.transfers + s.th.T2.transfers, retries: s.th.T1.retries + s.th.T2.retries,
        deadlocked: deadlocked(s), livelocked: livelocked(s),
      };
      s.rows = [...s.rows, row].slice(-6);
      return s;
    }
    case "restart": {
      const s = clone(st);
      restartRun(s);
      log(s, { ok: true, text: "Both threads start their next transfer from the top. All locks are free.", path: ["restart"] });
      return s;
    }
  }
}
