// Branch predictor lab: one filter loop, `if x >= t { sum += x }`, over 64 values.
//
// After this, the reader can answer: why does the same loop over the same numbers run several
// times faster when they are sorted, and how does branchless code get that speed without sorting?
// (The CPU guesses each branch before it knows the answer; a wrong guess throws away the work
// fetched behind it. What matters is whether the pattern of outcomes is predictable.)
//
// Predictors: always taken (static), 1-bit last outcome, 2-bit saturating counter, and a 2-bit
// counter per recent history (2 bits of global history select one of 4 counters, a tiny gshare).
// Cost model: a correctly predicted iteration costs 2 cycles, a mispredicted one 2 + 15 (the
// pipeline refills; real cores pay roughly 15-20). The branchless version computes a mask
// instead of branching and costs 3 cycles every time, whatever the data.
// Data: the same 64 random values sorted or shuffled, plus a periodic pattern (7 in, 1 out, like
// a loop exit) and an alternating one. The reader can drag the threshold and click a bar to move
// it across the threshold, and compares finished runs.
// Plain state + a pure step function, so it can be tested without a browser.

export const N = 64;
export const BASE = 2;
export const PENALTY = 15;
export const BRANCHLESS = 3;

export type Data = "sorted" | "random" | "periodic" | "alternating";
export type Predictor = "static" | "1bit" | "2bit" | "history";
export type Code = "branch" | "branchless";
export type Prediction = "same" | "bit" | "lots";
export type ChallengeId = "sorted" | "branchless" | "twobit" | "history" | "threshold";

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "sorted", text: "Run the branchy loop on sorted and on random data, and compare." },
  { id: "branchless", text: "Make random data fast without sorting it." },
  { id: "twobit", text: "On the periodic data, show a 2-bit counter beating a 1-bit one." },
  { id: "history", text: "Predict alternating data almost perfectly." },
  { id: "threshold", text: "Make random data predictable for the branchy loop without reordering it." },
];

export interface Outcome { i: number; x: number; taken: boolean; predicted: boolean | null; cycles: number }
export interface Run { id: number; label: string; data: Data; predictor: Predictor; code: Code; t: number; edited: boolean; mispredicts: number; cycles: number; sum: number }

export interface State {
  data: Data;
  predictor: Predictor;
  code: Code;
  t: number;
  values: number[];
  edited: boolean;
  /** Predictor state: one counter (0..3) per history pattern; static and 1-bit use slot 0. */
  counters: number[];
  history: number;
  pos: number;
  outcomes: Outcome[];
  sum: number;
  cycles: number;
  mispredicts: number;
  runs: Run[];
  nextRun: number;
  prediction: Prediction | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "data"; value: Data }
  | { type: "predictor"; value: Predictor }
  | { type: "code"; value: Code }
  | { type: "threshold"; value: number }
  | { type: "flip"; i: number }
  | { type: "step"; n: number }
  | { type: "run" }
  | { type: "predict"; value: Prediction }
  | { type: "reset" };

/* ---------------------------------------------------------------- data */

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

const RANDOM: number[] = (() => { const r = rng(20180103); return Array.from({ length: N }, () => Math.floor(r() * 256)); })();

/** Values for a data set. Sorted and random hold the same 64 numbers, so their sums match. */
export function makeValues(d: Data): number[] {
  if (d === "random") return RANDOM.slice();
  if (d === "sorted") return RANDOM.slice().sort((a, b) => a - b);
  const r = rng(d === "periodic" ? 7 : 2);
  const hi = () => 128 + Math.floor(r() * 128), lo = () => Math.floor(r() * 128);
  return Array.from({ length: N }, (_, i) => (d === "periodic" ? (i % 8 === 7 ? lo() : hi()) : i % 2 === 0 ? hi() : lo()));
}

/* ---------------------------------------------------------------- predictors */

export const slots = (p: Predictor) => (p === "history" ? 4 : 1);
const initCounters = (p: Predictor) => Array(slots(p)).fill(p === "1bit" ? 0 : 1);

/** The guess for the next branch, from the predictor's current state. */
export function guess(p: Predictor, counters: number[], history: number): boolean {
  if (p === "static") return true;
  if (p === "1bit") return counters[0] === 1;
  return counters[p === "history" ? history : 0] >= 2;
}

function train(p: Predictor, counters: number[], history: number, taken: boolean): { counters: number[]; history: number } {
  const c = counters.slice();
  if (p === "1bit") c[0] = taken ? 1 : 0;
  else if (p !== "static") {
    const k = p === "history" ? history : 0;
    c[k] = taken ? Math.min(3, c[k] + 1) : Math.max(0, c[k] - 1);
  }
  return { counters: c, history: ((history << 1) | (taken ? 1 : 0)) & 3 };
}

/* ---------------------------------------------------------------- the loop */

export const label = (st: Pick<State, "data" | "predictor" | "code" | "t" | "edited">) =>
  `${st.data}${st.edited ? " (edited)" : ""}, ${st.code === "branchless" ? "branchless" : `branch, ${PREDICTOR_NAMES[st.predictor]}`}${st.t !== 128 ? `, t = ${st.t}` : ""}`;

export const PREDICTOR_NAMES: Record<Predictor, string> = { static: "always taken", "1bit": "1-bit", "2bit": "2-bit counter", history: "2-bit + history" };

function fresh(st: State, patch: Partial<State> = {}): State {
  const n = { ...st, ...patch };
  return { ...n, counters: initCounters(n.predictor), history: 0, pos: 0, outcomes: [], sum: 0, cycles: 0, mispredicts: 0 };
}

const noneDone = (): Record<ChallengeId, boolean> => ({ sorted: false, branchless: false, twobit: false, history: false, threshold: false });

export function init(): State {
  const base = {
    data: "sorted", predictor: "2bit", code: "branch", t: 128, values: makeValues("sorted"), edited: false,
    runs: [], nextRun: 1, prediction: null, done: noneDone(),
  } as Partial<State>;
  return fresh(base as State);
}

/** Run one iteration. Pure. */
export function iterate(st: State): State {
  const x = st.values[st.pos];
  const taken = x >= st.t;
  let predicted: boolean | null = null, cycles: number, miss = false, counters = st.counters, history = st.history;
  if (st.code === "branchless") cycles = BRANCHLESS;
  else {
    predicted = guess(st.predictor, st.counters, st.history);
    miss = predicted !== taken;
    cycles = BASE + (miss ? PENALTY : 0);
    ({ counters, history } = train(st.predictor, st.counters, st.history, taken));
  }
  return {
    ...st, counters, history, pos: st.pos + 1,
    outcomes: [...st.outcomes, { i: st.pos, x, taken, predicted, cycles }],
    sum: st.sum + (taken ? x : 0), cycles: st.cycles + cycles, mispredicts: st.mispredicts + (miss ? 1 : 0),
  };
}

function finish(st: State): State {
  if (st.pos < N) return st;
  const run: Run = { id: st.nextRun, label: label(st), data: st.data, predictor: st.predictor, code: st.code, t: st.t, edited: st.edited, mispredicts: st.mispredicts, cycles: st.cycles, sum: st.sum };
  const runs = [run, ...st.runs].slice(0, 8);
  const done = { ...st.done };
  const plain = (r: Run) => !r.edited && r.t === 128;
  const find = (f: (r: Run) => boolean) => runs.find(f);
  const sortedB = find((r) => plain(r) && r.data === "sorted" && r.code === "branch");
  const randomB = find((r) => plain(r) && r.data === "random" && r.code === "branch");
  if (sortedB && randomB) done.sorted = true;
  if (run.data === "random" && !run.edited && run.code === "branchless" && randomB && run.cycles < randomB.cycles * 0.6) done.branchless = true;
  const p1 = find((r) => plain(r) && r.data === "periodic" && r.code === "branch" && r.predictor === "1bit");
  const p2 = find((r) => plain(r) && r.data === "periodic" && r.code === "branch" && r.predictor === "2bit");
  if (p1 && p2 && p2.mispredicts < p1.mispredicts) done.twobit = true;
  if (run.data === "alternating" && !run.edited && run.code === "branch" && run.mispredicts <= N / 10) done.history = true;
  if (run.data === "random" && !run.edited && run.code === "branch" && run.t !== 128 && run.mispredicts <= 2) done.threshold = true;
  return { ...st, runs, nextRun: st.nextRun + 1, done };
}

function advance(st: State, n: number): State {
  let s = st.pos >= N ? fresh(st) : st;
  for (let i = 0; i < n && s.pos < N; i++) s = iterate(s);
  return finish(s);
}

/** Move a value across the threshold, keeping its distance from it where possible. */
export function flipped(x: number, t: number): number {
  if (x >= t) return Math.max(0, t - 1 - (x - t));
  return Math.min(255, t + (t - 1 - x));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "data": return fresh(st, { data: a.value, values: makeValues(a.value), edited: false });
    case "predictor": return fresh(st, { predictor: a.value });
    case "code": return fresh(st, { code: a.value });
    case "threshold": return fresh(st, { t: Math.max(0, Math.min(256, Math.round(a.value))) });
    case "flip": {
      if (a.i < 0 || a.i >= N) return st;
      const values = st.values.slice();
      values[a.i] = flipped(values[a.i], st.t);
      return fresh(st, { values, edited: true });
    }
    case "step": return advance(st, a.n);
    case "run": return advance(st, N);
    case "predict": return { ...st, prediction: a.value };
    case "reset": return init();
  }
}

export const missRate = (r: { mispredicts: number }) => r.mispredicts / N;
/** Time for a million elements at 3 GHz, from cycles per element. */
export const msPerMillion = (cycles: number) => (cycles / N) * 1e6 / 3e9 * 1e3;

/** The slowest and fastest finished runs over the same values, for the reader's result. */
export function compare(st: State): { slow: Run; fast: Run } | null {
  if (st.runs.length < 2) return null;
  const slow = st.runs.reduce((a, b) => (b.cycles > a.cycles ? b : a));
  const fast = st.runs.reduce((a, b) => (b.cycles < a.cycles ? b : a));
  return slow.cycles > fast.cycles ? { slow, fast } : null;
}
