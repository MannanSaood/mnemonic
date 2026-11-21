// Work stealing: four Ps, and a burst of parse goroutines that all land on P0.
//
// Purpose. After this, the reader can answer: "If all the new work lands on one P, how do the
// other cores get any of it, without a central queue?" An idle P steals from a busy P's local
// queue, and it takes half of it, so a few steals are enough to spread the work. Without
// stealing, three cores sit idle while one does everything.
//
// Scenario: a log-ingest service. One connection delivers a burst, and its reader goroutine runs
// `go parse(batch)` 32 times on P0. A new goroutine goes on the creating P's queue, so all 32
// queue on P0. Three quiet connections give P1-P3 two small jobs each.
//
// Scaled, deterministic model:
// - 1 tick = 1 ms, 4 Ps on 4 cores. Jobs take whole ticks.
// - A P with nothing to run looks at its own queue, then (if stealing is on) tries the other Ps
//   in a pseudo-random order that changes every tick, like the runtime's randomised steal order.
// - "half" takes n - n/2 goroutines from the head of the victim's queue (runqgrab), runs the first
//   and keeps the rest. "one" takes a single goroutine, a what-if for comparison.
// - A running goroutine is never stolen. The runtime can also steal a P's runnext slot as a last
//   resort; the model leaves that out.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const PROCS = 4;
export const BURST = 32;
export const BACKGROUND = 2; // jobs per quiet P
export const BG_LEN = 2;

export type Mode = "off" | "one" | "half";
export const MODE_NAME: Record<Mode, string> = { off: "off", one: "one at a time", half: "half the queue" };
export type Lengths = "even" | "uneven";
export type Placement = "burst" | "spread";

/** Job lengths in ms. Both sets add up to 64 ms. */
export const UNEVEN = [1, 3, 1, 4, 2, 1, 3, 1];
export const lengthOf = (i: number, l: Lengths) => (l === "even" ? 2 : UNEVEN[i % UNEVEN.length]);

export interface G { id: number; len: number; left: number; origin: number; burst: boolean; ranOn: number | null; finished: number | null }
export interface P { id: number; run: number | null; q: number[] }
export interface Steal { t: number; thief: number; victim: number; n: number }
/** What a P did during one ms: the goroutine it ran, or null if it was idle. */
export interface Cell { g: number | null; origin: number | null; burst: boolean }

export interface RunResult { mode: Mode; lengths: Lengths; placement: Placement; makespan: number; idleWhileWaiting: number; steals: number; moved: number }

export type Guess = "60" | "20" | "32";

export interface State {
  mode: Mode;
  lengths: Lengths;
  placement: Placement;
  t: number;
  gs: Record<number, G>;
  ps: P[];
  steals: Steal[];
  timeline: Cell[][];
  idleWhileWaiting: number;
  done: boolean;
  guess: Guess | null;
  runs: RunResult[];
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "mode"; mode: Mode }
  | { type: "lengths"; lengths: Lengths }
  | { type: "placement"; placement: Placement }
  | { type: "tick" }
  | { type: "finish" }
  | { type: "clear" }
  | { type: "reset" };

function load(placement: Placement, lengths: Lengths): Pick<State, "gs" | "ps"> {
  const gs: Record<number, G> = {};
  const ps: P[] = Array.from({ length: PROCS }, (_, id) => ({ id, run: null, q: [] }));
  let id = 1;
  for (let i = 0; i < BURST; i++, id++) {
    const p = placement === "burst" ? 0 : i % PROCS;
    const len = lengthOf(i, lengths);
    gs[id] = { id, len, left: len, origin: p, burst: true, ranOn: null, finished: null };
    ps[p].q.push(id);
  }
  for (let p = 1; p < PROCS; p++) for (let j = 0; j < BACKGROUND; j++, id++) {
    gs[id] = { id, len: BG_LEN, left: BG_LEN, origin: p, burst: false, ranOn: null, finished: null };
    ps[p].q.push(id);
  }
  return { gs, ps };
}

function fresh(mode: Mode, lengths: Lengths, placement: Placement, keep?: Pick<State, "guess" | "runs">): State {
  return { mode, lengths, placement, t: 0, ...load(placement, lengths), steals: [], timeline: [], idleWhileWaiting: 0, done: false, guess: keep?.guess ?? null, runs: keep?.runs ?? [] };
}

export function init(): State {
  return fresh("off", "even", "burst");
}

export const totalWork = (s: State) => Object.values(s.gs).reduce((a, g) => a + g.len, 0);
export const queued = (s: { ps: P[] }) => s.ps.reduce((a, p) => a + p.q.length, 0);
export const moved = (s: State) => Object.values(s.gs).filter((g) => g.ranOn !== null && g.ranOn !== g.origin).length;
/** The best any schedule can do: total work over the cores, or the longest single job. */
export const ideal = (s: State) => Math.max(Math.ceil(totalWork(s) / PROCS), ...Object.values(s.gs).map((g) => g.len));

/** The order in which P `thief` tries the others at time t. Deterministic, changes every tick. */
export function stealOrder(thief: number, t: number): number[] {
  const others = Array.from({ length: PROCS }, (_, i) => i).filter((i) => i !== thief);
  const start = (t * 5 + thief * 3) % others.length;
  return [...others.slice(start), ...others.slice(0, start)];
}

function tick(s: State): State {
  if (s.done) return s;
  const gs: Record<number, G> = {};
  for (const [k, g] of Object.entries(s.gs)) gs[+k] = { ...g };
  const ps = s.ps.map((p) => ({ ...p, q: [...p.q] }));
  const steals: Steal[] = [];

  // 1. Every P without a goroutine finds one: its own queue, then a victim's.
  for (const p of ps) {
    if (p.run !== null) continue;
    if (p.q.length) { p.run = p.q.shift()!; continue; }
    if (s.mode === "off") continue;
    for (const v of stealOrder(p.id, s.t)) {
      const victim = ps[v];
      if (!victim.q.length) continue;
      const n = s.mode === "half" ? victim.q.length - Math.floor(victim.q.length / 2) : 1;
      const got = victim.q.splice(0, n);
      p.run = got[0];
      p.q.push(...got.slice(1));
      steals.push({ t: s.t, thief: p.id, victim: v, n });
      break;
    }
  }

  // 2. Run one ms. An idle P while goroutines wait in some queue is wasted capacity.
  const waiting = queued({ ps });
  const cells: Cell[] = ps.map((p) => {
    if (p.run === null) return { g: null, origin: null, burst: false };
    const g = gs[p.run];
    if (g.ranOn === null) g.ranOn = p.id;
    g.left -= 1;
    const cell = { g: g.id, origin: g.origin, burst: g.burst };
    if (g.left <= 0) { g.finished = s.t + 1; p.run = null; }
    return cell;
  });
  const idle = waiting > 0 ? cells.filter((c) => c.g === null).length : 0;
  const done = Object.values(gs).every((g) => g.finished !== null);
  const next: State = {
    ...s, t: s.t + 1, gs, ps, steals: [...s.steals, ...steals], timeline: [...s.timeline, cells],
    idleWhileWaiting: s.idleWhileWaiting + idle, done,
  };
  if (!done) return next;
  const res: RunResult = {
    mode: s.mode, lengths: s.lengths, placement: s.placement, makespan: next.t,
    idleWhileWaiting: next.idleWhileWaiting, steals: next.steals.length, moved: moved(next),
  };
  return { ...next, runs: [...s.runs, res] };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "guess": return s.runs.length ? s : { ...s, guess: a.guess };
    case "mode": return fresh(a.mode, s.lengths, s.placement, s);
    case "lengths": return fresh(s.mode, a.lengths, s.placement, s);
    case "placement": return fresh(s.mode, s.lengths, a.placement, s);
    case "clear": return fresh(s.mode, s.lengths, s.placement, s);
    case "tick": return tick(s);
    case "finish": {
      let cur = s;
      for (let i = 0; i < 500 && !cur.done; i++) cur = tick(cur);
      return cur;
    }
  }
}

/** Plays a whole run from a fresh board. Used by tests. */
export function simulate(mode: Mode, lengths: Lengths = "even", placement: Placement = "burst"): RunResult {
  const s = step(fresh(mode, lengths, placement), { type: "finish" });
  return s.runs[s.runs.length - 1];
}
