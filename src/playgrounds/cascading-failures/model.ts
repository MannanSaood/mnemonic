// Cascading failures: a chain of four services, each with a fixed pool of workers, where the
// database at the bottom slows down for a while.
//
// After this, the reader can answer: "How does one slow dependency take down services that never
// call it, and which defences stop the spread?"
// Core insight: a caller holds a worker while it waits, so a slow database fills the pool of the
// service above it, then the one above that, until the frontend has no workers left even for
// pages that never touch the database. Retries at every layer multiply the load on the one
// component that is short of capacity, and work nobody is waiting for keeps it busy after it
// recovers. Load shedding (fail fast when the queue is long), deadlines that travel with the
// request (drop work whose caller gave up) and a retry budget each cut one link of the loop.
//
// Pure and deterministic: discrete requests in 20 ms ticks over 40 simulated seconds.

export const TICK_MS = 20;
export const SECONDS = 40;
export const TICKS_PER_S = 1000 / TICK_MS;
export const TICKS = SECONDS * TICKS_PER_S;

export const TIERS = ["Frontend", "Checkout", "Inventory", "Database"] as const;
export const TIER_SHORT = ["FE", "CHK", "INV", "DB"] as const;
export type Tier = 0 | 1 | 2 | 3;
/** Workers (requests in progress at once) per service. */
export const WORKERS = [200, 120, 80, 8] as const;
/** Ticks of a service's own work. The database's grows during the slowdown. */
export const OWN_TICKS = { browse: 2, frontend: 1, checkout: 1, inventory: 1, db: 2, dbSlow: 12 } as const;
/** Per-attempt timeout each caller waits for the service below it, in ticks: 2 s, 1 s, 0.5 s. */
export const HOP_TIMEOUT = [100, 50, 25] as const;
/** A user gives up after 3 s. */
export const USER_TIMEOUT = 150;
/** Load shedding: the most requests a service lets wait in its queue (half its workers). */
export const SHED_QUEUE = [100, 60, 40, 4] as const;
/** Without shedding, queues are effectively unbounded. */
export const MAX_QUEUE = 5000;
/** Users per second for each page. Browse only needs the frontend; checkout goes down the chain. */
export const BROWSE_PER_S = 50;
export const CHECKOUT_PER_S = 50;
export const SLOW_START_S = 5;
export const DB_CAPACITY = (WORKERS[3] * 1000) / (OWN_TICKS.db * TICK_MS);
export const DB_CAPACITY_SLOW = (WORKERS[3] * 1000) / (OWN_TICKS.dbSlow * TICK_MS);

export type RetryMode = "every" | "one" | "budget";
export const RETRY_NAME: Record<RetryMode, string> = { every: "3 tries at every layer", one: "3 tries at one layer", budget: "3 tries, 10% budget" };
export interface Config {
  retries: RetryMode;
  deadlines: boolean;
  shedding: boolean;
  /** Length of the database slowdown in seconds; 0 means none. */
  slow: number;
}
export const SLOWS = [0, 5, 10, 20];

type Kind = "browse" | "checkout";
interface Call {
  tier: Tier;
  kind: Kind;
  parent: Call | null;
  start: number;
  deadline: number;
  state: "queued" | "own" | "wait" | "done";
  ok: boolean;
  ownLeft: number;
  child: Call | null;
  childSent: number;
  attempts: number;
  abandoned: boolean;
  userDone: boolean;
}

export interface Second {
  t: number;
  /** Calls arriving at each service this second, split into first attempts and retries. */
  first: number[];
  retries: number[];
  /** Workers busy and requests queued at each service at the end of the second. */
  busy: number[];
  queue: number[];
  /** Work finished for callers that had already given up, per service. */
  wasted: number[];
  /** Requests refused at once by load shedding, per service. */
  shed: number[];
  /** Requests dropped unstarted because their deadline had passed, per service. */
  expired: number[];
  browseOk: number; browseFail: number; checkoutOk: number; checkoutFail: number;
}

export interface Summary {
  browseFail: number;
  checkoutOk: number;
  checkoutFail: number;
  /** Highest calls per second reaching the database, and as a multiple of checkout users. */
  peakDb: number;
  amplification: number;
  dbWasted: number;
  /** Seconds after the database recovered until users were served normally again, or null. */
  recovery: number | null;
  /** First second each service's workers were all busy, or null. */
  saturatedAt: (number | null)[];
}

export interface Run { id: number; config: Config; seconds: Second[]; summary: Summary }

const maxAttempts = (c: Config, caller: Tier) => (c.retries === "one" ? (caller === 2 ? 3 : 1) : 3);
const BUDGET_RATIO = 0.1, BUDGET_MAX = 10;

/** Run the chain for 40 seconds. Pure and deterministic. */
export function simulate(c: Config): { seconds: Second[]; summary: Summary } {
  const queues: Call[][] = [[], [], [], []];
  const heads = [0, 0, 0, 0];
  const qLive = [0, 0, 0, 0];
  const running: Call[][] = [[], [], [], []];
  const busy = [0, 0, 0, 0];
  const tokens = [BUDGET_MAX, BUDGET_MAX, BUDGET_MAX];
  const users: Call[] = [];
  const seconds: Second[] = [];
  const blank = (t: number): Second => ({
    t, first: [0, 0, 0, 0], retries: [0, 0, 0, 0], busy: [0, 0, 0, 0], queue: [0, 0, 0, 0], wasted: [0, 0, 0, 0], shed: [0, 0, 0, 0], expired: [0, 0, 0, 0],
    browseOk: 0, browseFail: 0, checkoutOk: 0, checkoutFail: 0,
  });
  let cur = blank(0);
  const slowFrom = SLOW_START_S * TICKS_PER_S, slowTo = (SLOW_START_S + c.slow) * TICKS_PER_S;

  function userResult(u: Call, ok: boolean) {
    if (u.userDone) return;
    u.userDone = true;
    if (u.kind === "browse") ok ? cur.browseOk++ : cur.browseFail++;
    else ok ? cur.checkoutOk++ : cur.checkoutFail++;
  }

  function finish(call: Call, ok: boolean) {
    if (call.state === "done") return;
    if (call.state === "own" || call.state === "wait") busy[call.tier]--;
    if (call.state === "queued") qLive[call.tier]--;
    call.state = "done";
    call.ok = ok;
    if (ok && call.abandoned) cur.wasted[call.tier]++;
    if (call.tier === 0) userResult(call, ok);
  }

  /** The caller stopped waiting. With deadlines the callee stops too, all the way down. */
  function abandon(call: Call) {
    if (call.state === "done") return;
    call.abandoned = true;
    if (c.deadlines) {
      const child = call.child;
      finish(call, false);
      if (child) abandon(child);
    }
  }

  function enqueue(call: Call, t: number) {
    const tier = call.tier;
    if (call.attempts === 0 && call.parent && call.parent.attempts > 1) cur.retries[tier]++;
    else cur.first[tier]++;
    const limit = c.shedding ? SHED_QUEUE[tier] : MAX_QUEUE;
    if (qLive[tier] >= limit) {
      cur.shed[tier]++;
      call.state = "queued"; qLive[tier]++; // so finish() balances the count
      finish(call, false);
      return;
    }
    queues[tier].push(call);
    qLive[tier]++;
    void t;
  }

  function send(parent: Call, t: number) {
    const tier = (parent.tier + 1) as Tier;
    parent.attempts++;
    if (parent.attempts === 1 && parent.tier < 3) tokens[parent.tier] = Math.min(BUDGET_MAX, tokens[parent.tier] + BUDGET_RATIO);
    const child: Call = {
      tier, kind: parent.kind, parent, start: t,
      deadline: c.deadlines ? Math.min(parent.deadline, t + HOP_TIMEOUT[parent.tier as 0 | 1 | 2]) : Infinity,
      state: "queued", ok: false, ownLeft: 0, child: null, childSent: t, attempts: 0, abandoned: false, userDone: false,
    };
    parent.child = child;
    parent.childSent = t;
    parent.state = "wait";
    enqueue(child, t);
  }

  function mayRetry(call: Call): boolean {
    if (call.attempts >= maxAttempts(c, call.tier)) return false;
    if (c.retries === "budget") {
      if (tokens[call.tier] < 1) return false;
      tokens[call.tier] -= 1;
    }
    return true;
  }

  for (let t = 0; t < TICKS; t++) {
    // Users arrive: one browse and one checkout every tick.
    for (const kind of ["browse", "checkout"] as const) {
      const u: Call = {
        tier: 0, kind, parent: null, start: t, deadline: c.deadlines ? t + USER_TIMEOUT : Infinity,
        state: "queued", ok: false, ownLeft: 0, child: null, childSent: 0, attempts: 0, abandoned: false, userDone: false,
      };
      users.push(u);
      enqueue(u, t);
    }
    const dbOwn = t >= slowFrom && t < slowTo ? OWN_TICKS.dbSlow : OWN_TICKS.db;

    for (let tier = 3; tier >= 0; tier--) {
      // Work in progress.
      for (const call of running[tier]) {
        if (call.state === "done") continue;
        if (c.deadlines && t >= call.deadline) { abandon(call); continue; }
        if (call.state === "own") {
          if (--call.ownLeft > 0) continue;
          if (tier === 3 || call.kind === "browse") finish(call, true);
          else send(call, t);
        } else if (call.state === "wait") {
          const ch = call.child!;
          if (ch.state === "done" && ch.ok) { finish(call, true); continue; }
          const timedOut = t - call.childSent >= HOP_TIMEOUT[tier];
          if (ch.state === "done" || timedOut) {
            if (ch.state !== "done") abandon(ch);
            if (mayRetry(call)) send(call, t);
            else finish(call, false);
          }
        }
      }
      running[tier] = running[tier].filter((x) => x.state !== "done");
      // Start queued work on free workers, oldest first.
      const q = queues[tier];
      while (busy[tier] < WORKERS[tier] && heads[tier] < q.length) {
        const call = q[heads[tier]++];
        if (call.state === "done") continue;
        qLive[tier]--;
        if (c.deadlines && t >= call.deadline) { cur.expired[tier]++; call.state = "done"; call.ok = false; if (tier === 0) userResult(call, false); continue; }
        busy[tier]++;
        call.state = "own";
        call.ownLeft = tier === 3 ? dbOwn : tier === 0 ? (call.kind === "browse" ? OWN_TICKS.browse : OWN_TICKS.frontend) : 1;
        running[tier].push(call);
      }
      if (heads[tier] > 4096) { queues[tier] = q.slice(heads[tier]); heads[tier] = 0; }
    }

    // Users who have waited 3 s give up; without deadlines the frontend keeps working for them.
    for (const u of users) if (!u.userDone && t - u.start >= USER_TIMEOUT) { userResult(u, false); u.abandoned = true; }
    if (users.length > 2000) { const keep = users.filter((u) => !u.userDone); users.length = 0; users.push(...keep); }

    if ((t + 1) % TICKS_PER_S === 0) {
      cur.busy = [...busy];
      cur.queue = [...qLive];
      seconds.push(cur);
      cur = blank(seconds.length);
    }
  }
  return { seconds, summary: summarise(seconds, c) };
}

/** A second is healthy when at least 95% of each page's users were served. */
export const healthy = (s: Second) => s.browseOk >= 0.95 * BROWSE_PER_S && s.checkoutOk >= 0.95 * CHECKOUT_PER_S;

function summarise(seconds: Second[], c: Config): Summary {
  const sum = (f: (s: Second) => number) => seconds.reduce((a, s) => a + f(s), 0);
  const peakDb = Math.max(...seconds.map((s) => s.first[3] + s.retries[3]));
  let recovery: number | null = 0;
  if (c.slow > 0) {
    recovery = null;
    const end = SLOW_START_S + c.slow;
    for (let t = end; t + 3 <= seconds.length; t++) if (seconds.slice(t, t + 3).every(healthy)) { recovery = t - end; break; }
  }
  return {
    browseFail: sum((s) => s.browseFail),
    checkoutOk: sum((s) => s.checkoutOk),
    checkoutFail: sum((s) => s.checkoutFail),
    peakDb,
    amplification: peakDb / CHECKOUT_PER_S,
    dbWasted: sum((s) => s.wasted[3]),
    recovery,
    saturatedAt: [0, 1, 2, 3].map((i) => { const s = seconds.find((x) => x.busy[i] >= WORKERS[i]); return s ? s.t : null; }),
  };
}

/* ---------------- the reader's state ---------------- */

export const PRESETS: { id: string; label: string; config: Omit<Config, "slow"> }[] = [
  { id: "naive", label: "No defences", config: { retries: "every", deadlines: false, shedding: false } },
  { id: "kit", label: "All three defences", config: { retries: "budget", deadlines: true, shedding: true } },
];

export const CHALLENGES = [
  { id: "spread", text: "Make browsing fail, though browse pages never touch the database." },
  { id: "outlast", text: "Make the outage outlast a 10-second slowdown by 10 seconds or more." },
  { id: "contain", text: "Get through a 10-second slowdown with no browse errors and users served normally within 2 seconds of recovery." },
  { id: "amplify", text: "Make the database see more than 20 times the checkout traffic users send." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  config: Config;
  runs: Run[];
  shown: number | null;
  /** The second shown in the chain diagram. */
  at: number;
  seq: number;
  prediction: string | null;
}

export type Action =
  | { type: "set"; patch: Partial<Config> }
  | { type: "preset"; id: string }
  | { type: "run" }
  | { type: "show"; id: number }
  | { type: "at"; t: number }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { config: { ...PRESETS[0].config, slow: 10 }, runs: [], shown: null, at: 0, seq: 1, prediction: null };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return s.prediction ? s : { ...s, prediction: a.value };
    case "set": return { ...s, config: { ...s.config, ...a.patch } };
    case "preset": {
      const p = PRESETS.find((x) => x.id === a.id);
      return p ? { ...s, config: { ...p.config, slow: s.config.slow } } : s;
    }
    case "run": {
      const r = simulate(s.config);
      const run: Run = { id: s.seq, config: { ...s.config }, ...r };
      return { ...s, runs: [run, ...s.runs].slice(0, 5), shown: run.id, seq: s.seq + 1, at: Math.min(SECONDS - 1, SLOW_START_S + Math.max(3, s.config.slow)) };
    }
    case "show": return s.runs.some((r) => r.id === a.id) ? { ...s, shown: a.id } : s;
    case "at": return { ...s, at: Math.max(0, Math.min(SECONDS - 1, Math.round(a.t))) };
  }
}

export const shownRun = (s: State) => s.runs.find((r) => r.id === s.shown) ?? null;

export function describe(c: Config): string {
  const parts = [RETRY_NAME[c.retries]];
  if (c.deadlines) parts.push("deadlines");
  if (c.shedding) parts.push("shedding");
  return parts.join(", ");
}

export function challengeDone(s: State, id: ChallengeId): boolean {
  return s.runs.some((r) => {
    const m = r.summary;
    switch (id) {
      case "spread": return m.browseFail > 0;
      case "outlast": return r.config.slow === 10 && (m.recovery === null || m.recovery >= 10);
      case "contain": return r.config.slow === 10 && m.browseFail === 0 && m.recovery !== null && m.recovery <= 2;
      case "amplify": return m.amplification > 20;
    }
  });
}
