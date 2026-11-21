// Loop invariant playground: the binary search behind a webhook dispatcher's cursor, stepped one
// iteration at a time with the reader's chosen invariant checked at the loop head.
//
// After this, the reader can answer: "Which invariant proves this loop correct, and at which step
// (start, an iteration, or the exit) does it break when the code has an off-by-one?"
// Core insight: an invariant is a proof by induction over loop iterations. It must hold before the
// first iteration (base case), survive every iteration (inductive step), and together with the
// exit condition give the answer. The shipped search starts with hi = n - 1, so for a consumer
// that is caught up (cursor past the last event) the invariant is already false before the loop
// runs, and no amount of correct iterations can repair it. The answer comes back as n - 1 and the
// last event is delivered again on every poll.
//
// Pure and deterministic: a fixed event log, every run is a finite trace.

/** Sequence numbers of the events in the log, sorted, with gaps where events were compacted. */
export const LOG = [101, 104, 109, 113, 117, 120, 126, 131] as const;
export const N = LOG.length;
/** Cursors a consumer can send: before the first, equal to an event, between events, caught up. */
export const CURSORS = [100, 101, 104, 106, 113, 118, 126, 131, 132] as const;
export const CAUGHT_UP = 132;
export const MAX_ITERS = 12;
export const POLLS_PER_HOUR = 3600;

export type Init = "n-1" | "n";
export type Cond = "lt" | "le";
export type Left = "mid+1" | "mid";
export interface Variant { init: Init; cond: Cond; left: Left }
export const SHIPPED: Variant = { init: "n-1", cond: "lt", left: "mid+1" };
export const FIXED: Variant = { init: "n", cond: "lt", left: "mid+1" };
export const same = (a: Variant, b: Variant) => a.init === b.init && a.cond === b.cond && a.left === b.left;

export type InvId = "split" | "bounds" | "loBelow";
export const INVARIANTS: { id: InvId; text: string; note: string }[] = [
  { id: "split", text: "Every event left of lo is < since, and every event from hi on is ≥ since", note: "The split: what the loop has proved so far." },
  { id: "bounds", text: "0 ≤ lo ≤ hi ≤ n", note: "True, but says nothing about where the answer is." },
  { id: "loBelow", text: "The event at lo is < since", note: "Sounds right; check it on the first cursor." },
];

/** The true answer: the index of the first event with seq >= since, or n when there is none. */
export function truth(since: number): number {
  const i = LOG.findIndex((s) => s >= since);
  return i < 0 ? N : i;
}

export interface Frame {
  lo: number;
  hi: number;
  mid: number | null; // the mid read in the iteration that produced this frame
  went: "left" | "right" | null; // which half the iteration kept
}
export type Outcome = "ok" | "wrong" | "hang" | "crash";
export interface Trace { frames: Frame[]; outcome: Outcome; result: number | null; crashMid: number | null }

/** Run the search with the chosen lines. Frames are the loop-head states: start, then after each iteration. */
export function run(v: Variant, since: number): Trace {
  let lo = 0, hi = v.init === "n" ? N : N - 1;
  const frames: Frame[] = [{ lo, hi, mid: null, went: null }];
  const go = () => (v.cond === "lt" ? lo < hi : lo <= hi);
  while (go()) {
    if (frames.length > MAX_ITERS) return { frames, outcome: "hang", result: null, crashMid: null };
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid >= N || mid < 0) return { frames, outcome: "crash", result: null, crashMid: mid };
    let went: Frame["went"];
    if (LOG[mid] < since) { lo = v.left === "mid+1" ? mid + 1 : mid; went = "right"; }
    else { hi = mid; went = "left"; }
    const prev = frames[frames.length - 1];
    frames.push({ lo, hi, mid, went });
    // Nothing changed: the same state repeats forever.
    if (prev.lo === lo && prev.hi === hi) return { frames, outcome: "hang", result: null, crashMid: null };
  }
  return { frames, outcome: lo === truth(since) ? "ok" : "wrong", result: lo, crashMid: null };
}

/** Evaluate an invariant at one loop-head state. */
export function holds(inv: InvId, f: Frame, since: number): boolean {
  const { lo, hi } = f;
  switch (inv) {
    case "bounds":
      return 0 <= lo && lo <= hi && hi <= N;
    case "split": {
      for (let i = 0; i < Math.min(lo, N); i++) if (!(LOG[i] < since)) return false;
      for (let i = Math.max(hi, 0); i < N; i++) if (!(LOG[i] >= since)) return false;
      return true;
    }
    case "loBelow":
      return lo < N && LOG[lo] < since;
  }
}

/** The termination measure: hi - lo, a non-negative integer that must shrink every iteration. */
export const measure = (f: Frame) => f.hi - f.lo;

export interface Proof {
  base: boolean; // holds before the first iteration
  step: boolean; // every iteration that started with it true ended with it true
  firstBreak: number | null; // frame index where it is first false
  exit: "proves" | "silent" | "wrong" | "none"; // what it says at the end
}

/** The three parts of the induction for one run. */
export function proof(inv: InvId, t: Trace, since: number): Proof {
  const ok = t.frames.map((f) => holds(inv, f, since));
  const firstBreak = ok.indexOf(false);
  let step = true;
  for (let i = 1; i < ok.length; i++) if (ok[i - 1] && !ok[i]) step = false;
  let exit: Proof["exit"];
  if (t.outcome === "hang" || t.outcome === "crash") exit = "none";
  else if (inv === "bounds") exit = "silent";
  else if (inv === "split") exit = ok[ok.length - 1] ? "proves" : "wrong";
  else exit = "silent";
  return { base: ok[0], step, firstBreak: firstBreak < 0 ? null : firstBreak, exit };
}

/** Run every cursor through a variant: the exhaustive test. */
export function sweep(v: Variant) {
  const rows = CURSORS.map((c) => ({ since: c, trace: run(v, c) }));
  const count = (o: Outcome) => rows.filter((r) => r.trace.outcome === o).length;
  return { rows, ok: count("ok"), wrong: count("wrong"), hang: count("hang"), crash: count("crash") };
}

/** Duplicate deliveries per consumer-hour at one poll a second, if the caught-up answer is wrong. */
export function duplicatesPerHour(v: Variant): number {
  const t = run(v, CAUGHT_UP);
  if (t.outcome !== "wrong" || t.result === null) return 0;
  return (N - t.result) * POLLS_PER_HOUR;
}

export const CHALLENGES = [
  { id: "findBug", text: "Find the cursor the shipped search gets wrong." },
  { id: "fix", text: "Change one line so every cursor gets the right answer." },
  { id: "hang", text: "Make the loop run forever." },
  { id: "crash", text: "Make it read past the end of the log." },
  { id: "weak", text: "Pick an invariant that holds on every step of the fixed code but proves nothing." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  v: Variant;
  since: number;
  inv: InvId;
  pos: number; // which frame of the trace is shown
  prediction: string | null;
  sawCaughtUp: boolean; // ran the shipped code to the end with the caught-up cursor
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "since"; since: number }
  | { type: "toggle"; line: "init" | "cond" | "left" }
  | { type: "inv"; inv: InvId }
  | { type: "step" }
  | { type: "back" }
  | { type: "end" }
  | { type: "restart" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    v: SHIPPED, since: 113, inv: "split", pos: 0, prediction: null, sawCaughtUp: false,
    done: { findBug: false, fix: false, hang: false, crash: false, weak: false },
  };
}

export const lastPos = (s: State) => run(s.v, s.since).frames.length - 1;
/** The run has been stepped to its end (the outcome is visible). */
export const finished = (s: State) => s.pos >= lastPos(s);

function score(s: State): State {
  const d = { ...s.done };
  const t = run(s.v, s.since);
  const end = s.pos >= t.frames.length - 1;
  let saw = s.sawCaughtUp;
  if (end) {
    if (same(s.v, SHIPPED) && t.outcome === "wrong") d.findBug = true;
    if (same(s.v, SHIPPED) && s.since === CAUGHT_UP) saw = true;
    if (t.outcome === "hang") d.hang = true;
    if (t.outcome === "crash") d.crash = true;
  }
  const sw = sweep(s.v);
  if (sw.ok === CURSORS.length && !same(s.v, SHIPPED)) d.fix = true;
  if (s.inv === "bounds" && sw.ok === CURSORS.length) d.weak = true;
  return { ...s, sawCaughtUp: saw, done: d };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "since":
      return score({ ...s, since: a.since, pos: 0 });
    case "toggle": {
      const v = { ...s.v };
      if (a.line === "init") v.init = v.init === "n-1" ? "n" : "n-1";
      if (a.line === "cond") v.cond = v.cond === "lt" ? "le" : "lt";
      if (a.line === "left") v.left = v.left === "mid+1" ? "mid" : "mid+1";
      return score({ ...s, v, pos: 0 });
    }
    case "inv":
      return score({ ...s, inv: a.inv });
    case "step":
      return score({ ...s, pos: Math.min(s.pos + 1, lastPos(s)) });
    case "back":
      return { ...s, pos: Math.max(0, s.pos - 1) };
    case "end":
      return score({ ...s, pos: lastPos(s) });
    case "restart":
      return { ...s, pos: 0 };
  }
}
