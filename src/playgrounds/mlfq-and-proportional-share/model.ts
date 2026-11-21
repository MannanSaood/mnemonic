// MLFQ and proportional share playground: a multi-level feedback queue you can tune and game,
// with lottery and stride scheduling run on the same jobs for comparison.
//
// Purpose. After this, the reader can answer: "How does MLFQ tell interactive jobs from batch jobs
// without being told, how can a job game it, and what does proportional share do instead?" MLFQ
// watches how each job uses its time: a job that gives up the CPU early stays on top, a job that
// uses its whole allotment sinks. Without accounting, a job that gives up the CPU just before its
// allotment ends stays on top forever and takes most of the CPU; without a priority boost, the
// sunk batch job can starve. Lottery and stride ignore behaviour and split the CPU by tickets:
// stride exactly, lottery only on average.
//
// The model (1 step = 1 ms, deterministic for a given seed):
// - Jobs: CPU-bound (never blocks), interactive (1 ms of CPU, then waits 9 ms for input), and a
//   gamer (runs one ms short of the top-level allotment, then does a 1 ms I/O).
// - MLFQ, after OSTEP ch. 8: the highest non-empty level runs, round robin within a level, new jobs
//   start on top. Level k's allotment is `slice × 2^k`. With accounting on, time used at a level
//   adds up across bursts (Rule 4); with it off, blocking resets it (old Rules 4a/4b). Every
//   `boost` ms all jobs move to the top (Rule 5). A job that wakes at a higher level preempts.
// - Lottery: every ms, a ticket draw among the ready jobs. Stride: every ms, the ready job with
//   the lowest pass runs, and its pass grows by 10,000 / tickets. A job that wakes from I/O gets
//   its pass raised to the lowest pass among ready jobs, so it cannot replay the time it slept.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const WINDOW = 400;
export const SHORT_WINDOW = 40;
export const STRIDE_BIG = 10_000;
export const MAX_JOBS = 5;
export const INTERACTIVE_RUN = 1;
export const INTERACTIVE_WAIT = 9;
export const GAMER_IO = 1;

export type Kind = "cpu" | "interactive" | "gamer";
export type Policy = "mlfq" | "lottery" | "stride";
export const POLICIES: Policy[] = ["mlfq", "lottery", "stride"];
export const POLICY_NAME: Record<Policy, string> = { mlfq: "MLFQ", lottery: "Lottery", stride: "Stride" };
export const KIND_NAME: Record<Kind, string> = { cpu: "CPU-bound", interactive: "interactive", gamer: "gamer" };

export interface Job { id: number; name: string; kind: Kind; tickets: number }
export interface Config { levels: number; slice: number; boost: number; accounting: boolean }

export type SegState = "run" | "wait" | "block";
export interface Seg { state: SegState; level: number; start: number; end: number }

export interface JobResult {
  id: number;
  share: number; // fraction of the window this job ran
  shortShare: number; // fraction of the first SHORT_WINDOW ms
  worstWait: number; // longest stretch ready but not running, ms
  avgResponse: number | null; // interactive and gamer: mean wait from wake-up to running
  finalLevel: number;
  segs: Seg[];
}
export interface RunResult { policy: Policy; jobs: JobResult[]; boosts: number[]; idle: number }

export const allotment = (cfg: Config, level: number) => cfg.slice * 2 ** level;
const burst = (j: Job, cfg: Config) => (j.kind === "cpu" ? Infinity : j.kind === "interactive" ? INTERACTIVE_RUN : Math.max(1, cfg.slice - 1));
const ioTime = (j: Job) => (j.kind === "interactive" ? INTERACTIVE_WAIT : GAMER_IO);

/** Small seeded PRNG (mulberry32), so a lottery run is repeatable. */
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

interface Rt { j: Job; level: number; used: number; left: number; blockedUntil: number | null; pass: number; waitRun: number; worst: number; woke: boolean; responses: number[]; ran: number; ranShort: number; segs: Seg[] }

export function simulate(jobs: Job[], policy: Policy, cfg: Config, seed = 1): RunResult {
  const rand = rng(seed);
  const rts: Rt[] = jobs.map((j) => ({ j, level: 0, used: 0, left: burst(j, cfg), blockedUntil: null, pass: 0, waitRun: 0, worst: 0, woke: false, responses: [], ran: 0, ranShort: 0, segs: [] }));
  const queues: Rt[][] = Array.from({ length: cfg.levels }, () => []);
  for (const r of rts) queues[0].push(r);
  let cur: Rt | null = null;
  const boosts: number[] = [];
  let idle = 0;
  const ready = (r: Rt) => r.blockedUntil === null;
  const mark = (r: Rt, state: SegState, t: number) => {
    const level = policy === "mlfq" ? r.level : 0;
    const last = r.segs[r.segs.length - 1];
    if (last && last.state === state && last.level === level && last.end === t) last.end = t + 1;
    else r.segs.push({ state, level, start: t, end: t + 1 });
  };
  const remove = (r: Rt) => { const q = queues[r.level]; const i = q.indexOf(r); if (i >= 0) q.splice(i, 1); };

  for (let t = 0; t < WINDOW; t++) {
    // 1. Wake-ups.
    for (const r of rts) if (r.blockedUntil === t) {
      r.blockedUntil = null; r.left = burst(r.j, cfg); r.woke = true;
      if (policy === "mlfq") queues[r.level].push(r);
      if (policy === "stride") {
        const others = rts.filter((o) => o !== r && ready(o));
        if (others.length) r.pass = Math.max(r.pass, Math.min(...others.map((o) => o.pass)));
      }
    }
    // 2. Priority boost (MLFQ Rule 5).
    if (policy === "mlfq" && cfg.boost > 0 && t > 0 && t % cfg.boost === 0) {
      boosts.push(t);
      for (const q of queues) q.length = 0;
      for (const r of rts) { r.level = 0; r.used = 0; if (ready(r) && r !== cur) queues[0].push(r); }
    }
    // 3. Choose.
    if (policy === "mlfq") {
      const top = queues.findIndex((q) => q.length > 0);
      if (cur === null) { if (top >= 0) cur = queues[top].shift()!; }
      else if (top >= 0 && top < cur.level) { queues[cur.level].unshift(cur); cur = queues[top].shift()!; }
    } else {
      const rs = rts.filter(ready);
      cur = null;
      if (rs.length) {
        if (policy === "lottery") {
          const total = rs.reduce((a, r) => a + r.j.tickets, 0);
          let x = rand() * total;
          for (const r of rs) { x -= r.j.tickets; if (x < 0) { cur = r; break; } }
          cur ??= rs[rs.length - 1];
        } else {
          cur = rs.reduce((a, b) => (b.pass < a.pass ? b : a));
        }
      }
    }
    // 4. Run one ms.
    for (const r of rts) {
      if (r === cur) continue;
      if (ready(r)) { r.waitRun++; r.worst = Math.max(r.worst, r.waitRun); mark(r, "wait", t); }
      else mark(r, "block", t);
    }
    if (cur === null) { idle++; continue; }
    const c: Rt = cur;
    if (c.woke) { if (c.j.kind !== "cpu") c.responses.push(c.waitRun); c.woke = false; }
    c.waitRun = 0;
    mark(c, "run", t);
    c.ran++; if (t < SHORT_WINDOW) c.ranShort++;
    c.left--; c.used++;
    if (policy === "stride") c.pass += STRIDE_BIG / c.j.tickets;
    if (policy !== "mlfq") {
      if (c.left <= 0) c.blockedUntil = t + 1 + ioTime(c.j);
      cur = null;
      continue;
    }
    const spent = c.used >= allotment(cfg, c.level);
    if (c.left <= 0) {
      // Gives up the CPU for I/O.
      if (spent) { c.level = Math.min(cfg.levels - 1, c.level + 1); c.used = 0; }
      else if (!cfg.accounting) c.used = 0; // old Rule 4b: blocking resets the allotment
      c.blockedUntil = t + 1 + ioTime(c.j);
      cur = null;
    } else if (spent) {
      // Used its whole allotment: down one level (Rule 4), or round robin at the bottom.
      c.level = Math.min(cfg.levels - 1, c.level + 1); c.used = 0;
      queues[c.level].push(c);
      cur = null;
    }
  }
  return {
    policy, boosts, idle,
    jobs: rts.map((r) => ({
      id: r.j.id,
      share: r.ran / WINDOW,
      shortShare: r.ranShort / SHORT_WINDOW,
      worstWait: r.worst,
      avgResponse: r.responses.length ? r.responses.reduce((a, b) => a + b, 0) / r.responses.length : null,
      finalLevel: r.level,
      segs: r.segs,
    })),
  };
}

/* ---------------- state + step ---------------- */

export type Guess = "half" | "most" | "all";

export interface State {
  jobs: Job[];
  cfg: Config;
  policy: Policy;
  seed: number;
  ran: boolean;
  guess: Guess | null;
  nextId: number;
  /** The reader has run MLFQ with a gamer and no accounting (reveals the prediction). */
  sawGaming: boolean;
}

export type Action =
  | { type: "add"; kind: Kind }
  | { type: "remove"; id: number }
  | { type: "tickets"; id: number; tickets: number }
  | { type: "levels"; value: number }
  | { type: "slice"; value: number }
  | { type: "boost"; value: number }
  | { type: "accounting"; value: boolean }
  | { type: "policy"; policy: Policy }
  | { type: "reroll" }
  | { type: "run" }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

export const LEVELS = [2, 3, 4] as const;
export const SLICES = [5, 10, 20] as const;
export const BOOSTS = [0, 50, 100, 200] as const;
export const TICKETS = [25, 50, 100, 200] as const;
const NAMES: Record<Kind, string[]> = { cpu: ["batch", "encoder", "indexer"], interactive: ["editor", "shell", "api"], gamer: ["gamer", "sneaky", "hog"] };

export function init(): State {
  return {
    jobs: [
      { id: 1, name: "batch", kind: "cpu", tickets: 100 },
      { id: 2, name: "editor", kind: "interactive", tickets: 100 },
    ],
    cfg: { levels: 3, slice: 10, boost: 0, accounting: false },
    policy: "mlfq", seed: 1, ran: false, guess: null, nextId: 3, sawGaming: false,
  };
}

const gaming = (s: State) => s.ran && s.policy === "mlfq" && !s.cfg.accounting && s.jobs.some((j) => j.kind === "gamer");
const settle = (s: State): State => ({ ...s, sawGaming: s.sawGaming || gaming(s) });
const pick = <T extends number>(v: number, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "add": {
      if (s.jobs.length >= MAX_JOBS) return s;
      const used = new Set(s.jobs.map((j) => j.name));
      const name = NAMES[a.kind].find((n) => !used.has(n)) ?? `${a.kind}${s.nextId}`;
      return settle({ ...s, jobs: [...s.jobs, { id: s.nextId, name, kind: a.kind, tickets: 100 }], nextId: s.nextId + 1 });
    }
    case "remove": return s.jobs.length <= 1 ? s : settle({ ...s, jobs: s.jobs.filter((j) => j.id !== a.id) });
    case "tickets": return settle({ ...s, jobs: s.jobs.map((j) => (j.id === a.id ? { ...j, tickets: pick(a.tickets, TICKETS, 100) } : j)) });
    case "levels": return settle({ ...s, cfg: { ...s.cfg, levels: pick(a.value, LEVELS, 3) } });
    case "slice": return settle({ ...s, cfg: { ...s.cfg, slice: pick(a.value, SLICES, 10) } });
    case "boost": return settle({ ...s, cfg: { ...s.cfg, boost: pick(a.value, BOOSTS, 0) } });
    case "accounting": return settle({ ...s, cfg: { ...s.cfg, accounting: a.value } });
    case "policy": return settle({ ...s, policy: a.policy });
    case "reroll": return { ...s, seed: (s.seed * 48271) % 2147483647 || 1 };
    case "run": return settle({ ...s, ran: true });
    case "guess": return s.sawGaming ? s : { ...s, guess: a.guess };
  }
}

export function allRuns(s: Pick<State, "jobs" | "cfg" | "seed">): RunResult[] {
  return POLICIES.map((p) => simulate(s.jobs, p, s.cfg, s.seed));
}

/** Ticket share each job should get if every job wanted the CPU all the time. */
export function ticketShare(jobs: Job[], id: number): number {
  const total = jobs.reduce((a, j) => a + j.tickets, 0);
  return (jobs.find((j) => j.id === id)?.tickets ?? 0) / total;
}

/** Largest gap between a job's share and its ticket share, among CPU-hungry jobs (cpu and gamer). */
export function shareError(run: RunResult, jobs: Job[], short = false): number {
  const hungry = jobs.filter((j) => j.kind !== "interactive");
  if (hungry.length < 2) return 0;
  const total = hungry.reduce((a, j) => a + j.tickets, 0);
  // The interactive jobs take what they need first; the rest is split by tickets among the hungry jobs.
  const used = run.jobs.filter((r) => hungry.some((j) => j.id === r.id));
  const sum = used.reduce((a, r) => a + (short ? r.shortShare : r.share), 0) || 1;
  return Math.max(...used.map((r) => Math.abs((short ? r.shortShare : r.share) / sum - hungry.find((j) => j.id === r.id)!.tickets / total)));
}
