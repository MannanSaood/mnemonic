// Probes, startup and graceful shutdown: a Deployment of three pods behind a Service takes 30
// requests a second. At t = 10 s a rolling update (maxSurge 1, maxUnavailable 0) replaces v1 with
// v2. The reader sets the boot time, the startup, liveness and readiness probes, what the app does
// on SIGTERM, the preStop sleep and terminationGracePeriodSeconds, and can add a database outage.
// The whole run is simulated second by second and drawn as a timeline per pod, with every request
// counted as served or failed, and why.
//
// After this, the reader can answer: which requests does each probe and each shutdown setting
// save or lose? (Readiness decides when traffic may come, so without it new pods get requests
// before they listen. Liveness decides when to restart, so pointing it at a shared database turns
// an outage into a restart storm, and making it stricter than the boot time makes a crash loop
// that a startup probe prevents. On shutdown, endpoint removal and SIGTERM race: load balancers
// keep sending for a few seconds, so the app must keep serving through a preStop sleep and drain.)
//
// Rules follow the Kubernetes docs, simplified: probes run every periodSeconds from
// initialDelaySeconds after the container starts; startup holds liveness and readiness off until
// it succeeds; failureThreshold consecutive failures act (liveness and startup restart the
// container with backoff 10 s, 20 s, 40 s ... capped at 300 s; readiness marks it unready).
// Termination: the pod leaves the endpoints at once, the preStop hook runs, then SIGTERM, and
// SIGKILL at the grace deadline (2 s later if preStop is still running). Load balancers see
// endpoint changes LAG seconds late. Units are seconds. Pure functions, tested.

export const HORIZON = 200;
export const DEPLOY_AT = 10;
export const DB_DOWN: [number, number] = [115, 160];
export const LAG = 3;            // endpoint change -> every node's kube-proxy / the load balancer
export const RPS = 30;
export const SCHED = 2;          // pod created -> container started (schedule, pull, start)
export const READY_PERIOD = 2;
export const READY_FAIL = 3;
export const STARTUP_PERIOD = 5;
export const STARTUP_FAIL = 12;  // 60 s to boot
export const REPLICAS = 3;

export type OnTerm = "exit" | "drain" | "ignore";
export interface Settings {
  boot: number;
  startup: boolean;
  liveDelay: number;
  livePeriod: number;
  liveThreshold: number;
  liveDb: boolean;
  readiness: boolean;
  onTerm: OnTerm;
  preStop: number;
  grace: number;
  dbOutage: boolean;
}

export const NAIVE: Settings = {
  boot: 25, startup: false, liveDelay: 15, livePeriod: 10, liveThreshold: 3, liveDb: true,
  readiness: false, onTerm: "exit", preStop: 0, grace: 30, dbOutage: false,
};

export type Cause = "booting" | "refused" | "killed" | "noEndpoints" | "database";
export const CAUSES: Cause[] = ["booting", "refused", "killed", "noEndpoints", "database"];
export const CAUSE_LABEL: Record<Cause, string> = {
  booting: "sent to a pod not listening yet",
  refused: "refused by a pod shutting down or restarting",
  killed: "cut off mid-request",
  noEndpoints: "no ready endpoints at all",
  database: "during the database outage",
};

/** What a pod is doing in one second, for drawing. */
export type Seg = "none" | "pending" | "booting" | "up" | "ready" | "prestop" | "draining" | "lingering" | "backoff";
export type Mark = { t: number; kind: "restart" | "sigterm" | "sigkill" | "exit" };

export interface PodRun { name: string; version: 1 | 2; segs: Seg[]; marks: Mark[]; restarts: number; crashLoop: boolean }
export interface Second { ok: number; fail: Record<Cause, number>; endpoints: number }
export interface Run {
  pods: PodRun[];
  seconds: Second[];
  total: number;
  failed: Record<Cause, number>;
  avoidable: number;
  restarts: number;
  /** when the rollout completed (3 v2 ready, no v1 left serving), or null if it stalled */
  rolloutDone: number | null;
  /** the longest time an old pod took from being told to stop until its container was gone */
  shutdown: number | null;
}

/* ---------------- the simulation ---------------- */

interface P {
  name: string; version: 1 | 2; created: number;
  container: "waiting" | "running" | "backoff" | "gone";
  startedAt: number; backoffUntil: number; restarts: number;
  started: boolean; ready: boolean;
  liveFails: number; readyFails: number; startupFails: number;
  nextLive: number; nextReady: number; nextStartup: number;
  terminatingAt: number | null; sigtermAt: number | null; killAt: number | null; exitAt: number | null;
  accepting: boolean;
  killedAt: number | null;
  segs: Seg[]; marks: Mark[];
}

const dbDown = (s: Settings, t: number) => s.dbOutage && t >= DB_DOWN[0] && t < DB_DOWN[1];

function newPod(name: string, version: 1 | 2, t: number, s: Settings, running: boolean): P {
  const p: P = {
    name, version, created: t, container: "waiting", startedAt: 0, backoffUntil: 0, restarts: 0,
    started: false, ready: false, liveFails: 0, readyFails: 0, startupFails: 0,
    nextLive: 0, nextReady: 0, nextStartup: 0,
    terminatingAt: null, sigtermAt: null, killAt: null, exitAt: null, accepting: true, killedAt: null,
    segs: [], marks: [],
  };
  if (running) {
    // The v1 pods have been up for a long time.
    start(p, -1000, s);
    p.started = true;
    p.ready = true;
  }
  return p;
}

function start(p: P, t: number, s: Settings) {
  p.container = "running";
  p.startedAt = t;
  p.started = !s.startup;
  p.ready = false;
  p.accepting = true;
  p.liveFails = p.readyFails = p.startupFails = 0;
  p.nextStartup = t;
  p.nextLive = t + s.liveDelay;
  p.nextReady = t;
}

const listening = (p: P, t: number, s: Settings) => p.container === "running" && p.accepting && t - p.startedAt >= s.boot;

function restart(p: P, t: number, s: Settings) {
  if (listening(p, t, s)) p.killedAt = t;
  p.container = "backoff";
  p.backoffUntil = t + Math.min(300, 10 * 2 ** p.restarts);
  p.restarts++;
  p.ready = false;
  p.started = false;
  p.marks.push({ t, kind: "restart" });
}

function terminate(p: P, t: number, s: Settings) {
  p.terminatingAt = t;
  p.ready = false;
  if (p.container !== "running") { p.container = "gone"; p.exitAt = t; return; }
  if (s.preStop < s.grace) p.sigtermAt = t + s.preStop;
  p.killAt = t + s.grace + (s.preStop >= s.grace ? 2 : 0);
}

export function simulate(s: Settings): Run {
  const pods: P[] = [1, 2, 3].map((i) => newPod(`v1-${i}`, 1, 0, s, true));
  let v2seq = 0;
  const endpointsAt: string[][] = [];
  const seconds: Second[] = [];
  let rolloutDone: number | null = null;

  for (let t = 0; t < HORIZON; t++) {
    // 1. the Deployment controller: maxSurge 1, maxUnavailable 0
    if (t >= DEPLOY_AT) {
      const live = pods.filter((p) => p.terminatingAt === null && p.container !== "gone");
      const readyLive = live.filter((p) => p.ready);
      const v1 = live.filter((p) => p.version === 1);
      const v2 = live.filter((p) => p.version === 2);
      if (readyLive.length > REPLICAS && v1.length) terminate(v1.find((p) => !p.ready) ?? v1[0], t, s);
      else if (v1.length && !v1.some((p) => p.ready)) terminate(v1[0], t, s); // unready old pods cost nothing to remove
      const liveNow = pods.filter((p) => p.terminatingAt === null && p.container !== "gone");
      if (liveNow.filter((p) => p.version === 2).length < REPLICAS && liveNow.length < REPLICAS + 1 && v2.length < REPLICAS)
        pods.push(newPod(`v2-${++v2seq}`, 2, t, s, false));
      const after = pods.filter((p) => p.terminatingAt === null && p.container !== "gone");
      if (rolloutDone === null && after.every((p) => p.version === 2) && after.filter((p) => p.ready).length === REPLICAS) rolloutDone = t;
    }

    // 2. kubelets: containers, probes, termination
    for (const p of pods) {
      p.killedAt = null;
      if (p.container === "waiting" && t >= p.created + SCHED && p.terminatingAt === null) start(p, t, s);
      if (p.container === "backoff" && t >= p.backoffUntil && p.terminatingAt === null) start(p, t, s);
      if (p.container === "running" && p.terminatingAt === null) {
        const up = listening(p, t, s);
        if (!p.started && t >= p.nextStartup) {
          p.nextStartup = t + STARTUP_PERIOD;
          if (up) { p.started = true; p.nextLive = Math.max(t, p.startedAt + s.liveDelay); p.nextReady = t; }
          else if (++p.startupFails >= STARTUP_FAIL) restart(p, t, s);
        }
        if (p.container === "running" && p.started) {
          if (t >= p.nextLive) {
            p.nextLive = t + s.livePeriod;
            const ok = up && !(s.liveDb && dbDown(s, t));
            if (ok) p.liveFails = 0;
            else if (++p.liveFails >= s.liveThreshold) restart(p, t, s);
          }
          if (p.container === "running") {
            if (!s.readiness) p.ready = true;
            else if (t >= p.nextReady) {
              p.nextReady = t + READY_PERIOD;
              if (up && !dbDown(s, t)) { p.ready = true; p.readyFails = 0; }
              else if (++p.readyFails >= READY_FAIL || !p.ready) p.ready = false;
            }
          }
        }
      }
      if (p.terminatingAt !== null && p.container === "running") {
        if (t === p.sigtermAt) {
          p.marks.push({ t, kind: "sigterm" });
          if (s.onTerm === "exit") { if (listening(p, t, s)) p.killedAt = t; p.container = "gone"; p.exitAt = t; p.marks.push({ t, kind: "exit" }); }
          else if (s.onTerm === "drain") { p.accepting = false; }
        }
        if (p.container === "running" && s.onTerm === "drain" && p.sigtermAt !== null && t === p.sigtermAt + 1) {
          p.container = "gone"; p.exitAt = t; p.marks.push({ t, kind: "exit" });
        }
        if (p.container === "running" && t >= (p.killAt ?? Infinity)) {
          if (listening(p, t, s)) p.killedAt = t;
          p.container = "gone"; p.exitAt = t; p.marks.push({ t, kind: "sigkill" });
        }
      }
    }

    // 3. endpoints, and what the load balancer sees LAG seconds later
    endpointsAt[t] = pods.filter((p) => p.ready && p.terminatingAt === null && p.container === "running").map((p) => p.name);
    const view = endpointsAt[Math.max(0, t - LAG)];
    const sec: Second = { ok: 0, fail: { booting: 0, refused: 0, killed: 0, noEndpoints: 0, database: 0 }, endpoints: endpointsAt[t].length };
    // Right after the outage, readiness and the load balancer need a few seconds to notice: still the outage's cost.
    const outage = s.dbOutage && t >= DB_DOWN[0] && t < DB_DOWN[1] + LAG + READY_PERIOD;
    if (!view.length) sec.fail[outage ? "database" : "noEndpoints"] += RPS;
    for (const name of view) {
      const p = pods.find((x) => x.name === name)!;
      const share = RPS / view.length;
      if (p.killedAt === t) sec.fail.killed += share;
      else if (listening(p, t, s)) { if (dbDown(s, t)) sec.fail.database += share; else sec.ok += share; }
      else if (p.container === "running" && p.accepting && p.terminatingAt === null) sec.fail.booting += share;
      else sec.fail.refused += share;
    }
    seconds.push(sec);

    // 4. what to draw
    for (const p of pods) p.segs[t] = seg(p, t, s);
  }

  const failed = { booting: 0, refused: 0, killed: 0, noEndpoints: 0, database: 0 } as Record<Cause, number>;
  for (const sec of seconds) for (const c of CAUSES) failed[c] += sec.fail[c];
  for (const c of CAUSES) failed[c] = Math.round(failed[c]);
  const restarts = pods.reduce((a, p) => a + p.restarts, 0);
  return {
    pods: pods.map((p) => ({
      name: p.name, version: p.version, segs: Array.from({ length: HORIZON }, (_, i) => p.segs[i] ?? "none"),
      marks: p.marks.filter((m) => m.t >= 0), restarts: p.restarts, crashLoop: p.restarts >= 2,
    })),
    seconds, total: RPS * HORIZON, failed,
    avoidable: CAUSES.filter((c) => c !== "database").reduce((a, c) => a + failed[c], 0),
    restarts, rolloutDone,
    shutdown: pods.reduce<number | null>((m, p) => (p.terminatingAt !== null && p.exitAt !== null ? Math.max(m ?? 0, p.exitAt - p.terminatingAt) : m), null),
  };
}

function seg(p: P, t: number, s: Settings): Seg {
  if (t < p.created || p.container === "gone") return "none";
  if (p.container === "waiting") return "pending";
  if (p.container === "backoff") return "backoff";
  if (p.terminatingAt !== null) {
    if (p.sigtermAt === null || t < p.sigtermAt) return "prestop";
    return s.onTerm === "ignore" ? "lingering" : "draining";
  }
  if (t - p.startedAt < s.boot) return "booting";
  return p.ready ? "ready" : "up";
}

/* ---------------- the playground's state ---------------- */

export interface Goals { clean: boolean; quick: boolean; storm: boolean; crashLoop: boolean; survived: boolean }
export interface State { settings: Settings; run: Run | null; previous: { failed: number; restarts: number } | null; found: Goals }

export type Action =
  | { type: "set"; patch: Partial<Settings> }
  | { type: "run" }
  | { type: "reset" };

export function init(): State {
  return { settings: { ...NAIVE }, run: null, previous: null, found: { clean: false, quick: false, storm: false, crashLoop: false, survived: false } };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "set": {
      const n = { ...st.settings, ...a.patch };
      const settings: Settings = {
        ...n, boot: clamp(n.boot, 1, 90), liveDelay: clamp(n.liveDelay, 0, 120), livePeriod: clamp(n.livePeriod, 1, 60),
        liveThreshold: clamp(n.liveThreshold, 1, 10), preStop: clamp(n.preStop, 0, 60), grace: clamp(n.grace, 1, 120),
      };
      const next = { ...st, settings };
      return st.run ? runIt(next) : next;
    }
    case "run":
      return runIt(st);
  }
}

function runIt(st: State): State {
  const run = simulate(st.settings);
  const s = st.settings;
  const f = { ...st.found };
  const deployClean = run.avoidable === 0 && run.rolloutDone !== null;
  if (deployClean) f.clean = true;
  if (deployClean && run.shutdown !== null && run.shutdown <= 10) f.quick = true;
  if (s.dbOutage && run.pods.filter((p) => p.marks.some((m) => m.kind === "restart" && m.t >= DB_DOWN[0])).length >= REPLICAS) f.storm = true;
  if (run.rolloutDone === null && run.pods.some((p) => p.version === 2 && p.crashLoop)) f.crashLoop = true;
  if (s.dbOutage && run.restarts === 0 && run.avoidable === 0 && run.rolloutDone !== null) f.survived = true;
  return { ...st, run, previous: st.run ? { failed: st.run.avoidable, restarts: st.run.restarts } : null, found: f };
}

export const CHALLENGES: { id: keyof Goals; text: string }[] = [
  { id: "clean", text: "Deploy with zero failed requests." },
  { id: "quick", text: "Zero failures, and every old pod gone within 10 s of being told to stop." },
  { id: "storm", text: "Turn on the database outage and make it restart every pod." },
  { id: "crashLoop", text: "Make the rollout stall with a v2 pod in CrashLoopBackOff." },
  { id: "survived", text: "Ride out the database outage with no restarts and no avoidable failures." },
];
