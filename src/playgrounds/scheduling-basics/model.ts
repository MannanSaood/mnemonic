// Scheduling basics playground: the same jobs under FIFO, SJF, STCF and round robin, side by side.
//
// Purpose. After this, the reader can answer: "Which policy should run next, and by which metric?"
// Running the shortest job first minimises average turnaround (and the preemptive version, STCF,
// keeps that true when jobs arrive late), but it needs run times you rarely know and it makes
// long jobs wait. Round robin gives every job a quick first turn (good response time) at the cost
// of stretching every job out (bad turnaround), and a very short slice wastes the CPU on switches.
// FIFO is the convoy: short jobs stuck behind a long one.
//
// Units are milliseconds, one simulation step = 1 ms, so everything stays integer and
// deterministic. A context switch costs `switchCost` ms whenever the CPU moves from one job to a
// different one (applied to every policy). Round robin: new arrivals join the back of the queue
// before a preempted job does, as in OSTEP's examples.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Policy = "fifo" | "sjf" | "stcf" | "rr";
export const POLICIES: Policy[] = ["fifo", "sjf", "stcf", "rr"];
export const POLICY_NAME: Record<Policy, string> = { fifo: "FIFO", sjf: "SJF", stcf: "STCF", rr: "Round robin" };
export const POLICY_NOTE: Record<Policy, string> = {
  fifo: "first come, first served, to completion",
  sjf: "shortest run time first, to completion",
  stcf: "shortest time left first, preempts on arrival",
  rr: "a slice each, in turn",
};

export type JobKind = "batch" | "interactive";
export interface Job { id: number; name: string; kind: JobKind; arrival: number; run: number }

export interface Seg { job: number | "switch" | "idle"; start: number; end: number }
export interface JobStat { id: number; turnaround: number; response: number; completion: number }
export interface Schedule {
  policy: Policy;
  segs: Seg[];
  stats: JobStat[];
  avgTurnaround: number;
  avgResponse: number;
  /** Worst response among interactive jobs (or all jobs when there are none). */
  worstInteractive: number;
  switches: number;
  switchMs: number;
  makespan: number;
}

export const MAX_JOBS = 6;
export const MAX_RUN = 200;
export const MAX_ARRIVAL = 200;
export const QUANTA = [1, 5, 10, 20] as const;
export const SWITCH_COSTS = [0, 1] as const;

const LIMIT = 5000;

function pickBy(ids: number[], jobs: Map<number, Job>, key: (j: Job) => number): number | null {
  let best: number | null = null;
  for (const id of ids) {
    if (best === null) { best = id; continue; }
    const a = jobs.get(id)!, b = jobs.get(best)!;
    const ka = key(a), kb = key(b);
    if (ka < kb || (ka === kb && (a.arrival < b.arrival || (a.arrival === b.arrival && a.id < b.id)))) best = id;
  }
  return best;
}

/** Runs one policy over the jobs. Pure and deterministic. */
export function schedule(jobsIn: Job[], policy: Policy, quantum = 10, switchCost = 0): Schedule {
  const jobs = new Map(jobsIn.map((j) => [j.id, j]));
  const left = new Map(jobsIn.map((j) => [j.id, j.run]));
  const first = new Map<number, number>();
  const completion = new Map<number, number>();
  const ready: number[] = [];
  const rr: number[] = [];
  const order = [...jobsIn].sort((a, b) => a.arrival - b.arrival || a.id - b.id);
  const segs: Seg[] = [];
  const mark = (job: Seg["job"], t: number) => {
    const last = segs[segs.length - 1];
    if (last && last.job === job && last.end === t) last.end = t + 1;
    else segs.push({ job, start: t, end: t + 1 });
  };
  let cur: number | null = null, last: number | null = null, slice = 0, sw = 0, swFor: number | null = null;
  let switches = 0, switchMs = 0;

  for (let t = 0; t < LIMIT; t++) {
    for (const j of order) if (j.arrival === t) { ready.push(j.id); rr.push(j.id); }
    if (completion.size === jobsIn.length) break;
    if (sw > 0) { sw--; switchMs++; mark("switch", t); continue; }

    if (policy === "fifo" || policy === "sjf") {
      if (cur === null) cur = pickBy(ready, jobs, policy === "fifo" ? (j) => j.arrival : (j) => j.run);
    } else if (policy === "stcf") {
      const cand = pickBy(ready, jobs, (j) => left.get(j.id)!);
      if (cand !== null && (cur === null || left.get(cand)! < left.get(cur)!)) cur = cand;
    } else {
      if (cur !== null && slice >= quantum) {
        if (rr.length > 0) { rr.push(cur); cur = null; } else slice = 0;
      }
      if (cur === null) { cur = rr.shift() ?? null; slice = 0; }
    }
    if (cur === null) { mark("idle", t); continue; }

    if (switchCost > 0 && last !== null && cur !== last && swFor !== cur) {
      swFor = cur; switches++; sw = switchCost - 1; switchMs++; mark("switch", t);
      continue;
    }
    if (last !== null && cur !== last && switchCost === 0) switches++;
    swFor = null; last = cur;
    if (!first.has(cur)) first.set(cur, t);
    left.set(cur, left.get(cur)! - 1);
    slice++;
    mark(cur, t);
    if (left.get(cur) === 0) {
      completion.set(cur, t + 1);
      ready.splice(ready.indexOf(cur), 1);
      cur = null;
    }
  }

  const stats: JobStat[] = jobsIn.map((j) => ({
    id: j.id,
    completion: completion.get(j.id) ?? LIMIT,
    turnaround: (completion.get(j.id) ?? LIMIT) - j.arrival,
    response: (first.get(j.id) ?? LIMIT) - j.arrival,
  }));
  const n = Math.max(1, stats.length);
  const inter = jobsIn.filter((j) => j.kind === "interactive").map((j) => stats.find((s) => s.id === j.id)!.response);
  return {
    policy, segs, stats,
    avgTurnaround: stats.reduce((a, s) => a + s.turnaround, 0) / n,
    avgResponse: stats.reduce((a, s) => a + s.response, 0) / n,
    worstInteractive: Math.max(0, ...(inter.length ? inter : stats.map((s) => s.response))),
    switches, switchMs,
    makespan: Math.max(0, ...stats.map((s) => s.completion)),
  };
}

/* ---------------- presets ---------------- */

export type Preset = "convoy" | "late" | "mixed";
export const PRESET_NAME: Record<Preset, string> = { convoy: "Convoy", late: "Late arrivals", mixed: "Batch + interactive" };

export function preset(p: Preset): Job[] {
  switch (p) {
    case "convoy":
      return [
        { id: 1, name: "export", kind: "batch", arrival: 0, run: 100 },
        { id: 2, name: "reset email", kind: "interactive", arrival: 0, run: 10 },
        { id: 3, name: "thumbnail", kind: "interactive", arrival: 0, run: 10 },
      ];
    case "late":
      return [
        { id: 1, name: "export", kind: "batch", arrival: 0, run: 100 },
        { id: 2, name: "reset email", kind: "interactive", arrival: 10, run: 10 },
        { id: 3, name: "thumbnail", kind: "interactive", arrival: 10, run: 10 },
      ];
    case "mixed":
      return [
        { id: 1, name: "export", kind: "batch", arrival: 0, run: 80 },
        { id: 2, name: "report", kind: "batch", arrival: 5, run: 40 },
        { id: 3, name: "login", kind: "interactive", arrival: 10, run: 5 },
        { id: 4, name: "search", kind: "interactive", arrival: 20, run: 5 },
        { id: 5, name: "checkout", kind: "interactive", arrival: 30, run: 5 },
      ];
  }
}

/* ---------------- state + step ---------------- */

export type Guess = "110" | "80" | "50";

export interface State {
  jobs: Job[];
  preset: Preset | null;
  quantum: number;
  switchCost: number;
  ran: boolean;
  guess: Guess | null;
  nextId: number;
  /** Which policies' charts the reader has seen with a 1 ms slice and a 1 ms switch (the break-it). */
  brokeRR: boolean;
}

export type Action =
  | { type: "preset"; preset: Preset }
  | { type: "arrival"; id: number; value: number }
  | { type: "run"; id: number; value: number }
  | { type: "add"; kind: JobKind }
  | { type: "remove"; id: number }
  | { type: "quantum"; value: number }
  | { type: "switchCost"; value: number }
  | { type: "go" }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

export function init(): State {
  return { jobs: preset("convoy"), preset: "convoy", quantum: 10, switchCost: 0, ran: false, guess: null, nextId: 4, brokeRR: false };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));
const NAMES: Record<JobKind, string[]> = { batch: ["backup", "reindex", "csv import"], interactive: ["profile", "cart", "webhook"] };

function withBroke(s: State): State {
  return { ...s, brokeRR: s.brokeRR || (s.ran && s.quantum === 1 && s.switchCost === 1) };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "preset": {
      const jobs = preset(a.preset);
      return { ...s, jobs, preset: a.preset, nextId: Math.max(...jobs.map((j) => j.id)) + 1 };
    }
    case "arrival":
      return { ...s, preset: null, jobs: s.jobs.map((j) => (j.id === a.id ? { ...j, arrival: clamp(a.value, 0, MAX_ARRIVAL) } : j)) };
    case "run":
      return { ...s, preset: null, jobs: s.jobs.map((j) => (j.id === a.id ? { ...j, run: clamp(a.value, 1, MAX_RUN) } : j)) };
    case "add": {
      if (s.jobs.length >= MAX_JOBS) return s;
      const used = new Set(s.jobs.map((j) => j.name));
      const name = NAMES[a.kind].find((n) => !used.has(n)) ?? `${a.kind} ${s.nextId}`;
      const job: Job = { id: s.nextId, name, kind: a.kind, arrival: 0, run: a.kind === "batch" ? 60 : 5 };
      return { ...s, preset: null, jobs: [...s.jobs, job], nextId: s.nextId + 1 };
    }
    case "remove":
      return s.jobs.length <= 1 ? s : { ...s, preset: null, jobs: s.jobs.filter((j) => j.id !== a.id) };
    case "quantum": return withBroke({ ...s, quantum: clamp(a.value, 1, 50) });
    case "switchCost": return withBroke({ ...s, switchCost: clamp(a.value, 0, 5) });
    case "go": return withBroke({ ...s, ran: true });
    case "guess": return s.ran ? s : { ...s, guess: a.guess };
  }
}

export function allSchedules(s: Pick<State, "jobs" | "quantum" | "switchCost">): Schedule[] {
  return POLICIES.map((p) => schedule(s.jobs, p, s.quantum, s.switchCost));
}

/** The reader's own result: who wins each metric on their jobs, and by how much against FIFO. */
export function verdict(scheds: Schedule[]) {
  const by = (k: "avgTurnaround" | "avgResponse") => scheds.reduce((a, b) => (b[k] < a[k] ? b : a));
  const fifo = scheds.find((x) => x.policy === "fifo")!;
  return { turnaround: by("avgTurnaround"), response: by("avgResponse"), fifo, rr: scheds.find((x) => x.policy === "rr")! };
}
