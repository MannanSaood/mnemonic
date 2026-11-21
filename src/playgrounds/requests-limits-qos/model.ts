// Requests, limits and QoS: one node with 4 CPUs and 8 GiB allocatable runs an API, a cache, a
// report job and a log shipper, and optionally a nightly import. The reader sets CPU and memory
// requests and limits per pod, and a 60 s run is simulated second by second: the scheduler places
// pods by their requests, the CFS quota throttles CPU above the limit in each 100 ms period,
// requests weight the CPU when the node is contended, a container above its memory limit is
// OOM-killed, and when the node runs short of memory the kubelet evicts (or the kernel OOM killer
// kills) by the real rules.
//
// After this, the reader can answer: what does each of request and limit do, for CPU and for
// memory? (Requests are what the scheduler adds up and how CPU is shared under contention; a CPU
// limit throttles a container in every 100 ms period it overruns, even when its average is low and
// the node is idle; a memory limit kills it; and when the node runs out of memory, pods using
// more than they requested go first, which a QoS class only summarises.)
//
// Rules from the Kubernetes docs, simplified: QoS Guaranteed when every request equals its limit
// for CPU and memory, BestEffort when nothing is set, Burstable otherwise; a limit with no request
// makes the request equal the limit. oom_score_adj: Guaranteed -997, BestEffort 1000, Burstable
// min(max(2, 1000 - 1000 * memRequest / capacity), 999). Kubelet eviction (one pod per check):
// pods whose usage exceeds requests first, the largest excess first; priority is equal here.
// CPU limit -> quota = limit x 100 ms per period; work beyond it waits for the next period.
// Units: millicores and MiB. Pure functions, tested.

export const NODE_CPU = 4000;
export const NODE_MEM = 8192;
export const EVICT_BELOW = 512;   // memory.available threshold (a common managed setting; the upstream default is 100Mi)
export const CHECK_EVERY = 5;     // kubelet eviction checks, s
export const HORIZON = 60;
export const PERIOD = 100;        // CFS period, ms
export const THREADS = 4;         // the API's worker threads
export const BACKOFF = 10;

export type PodId = "api" | "cache" | "report" | "shipper" | "import";
export const PODS: PodId[] = ["api", "cache", "report", "shipper", "import"];
export const POD_INFO: Record<PodId, { name: string; role: string }> = {
  api: { name: "api", role: "latency-sensitive HTTP, 4 threads, bursty" },
  cache: { name: "cache", role: "in-memory cache, steady" },
  report: { name: "report", role: "batch job, memory grows" },
  shipper: { name: "log-shipper", role: "small, set up long ago" },
  import: { name: "import", role: "the new nightly import" },
};

export interface Res { cpuReq: number | null; cpuLim: number | null; memReq: number | null; memLim: number | null }
export interface Settings {
  res: Record<PodId, Res>;
  importOn: boolean;
  noisy: boolean;   // the report job wants every CPU
  bigReport: boolean; // the report peaks at 4.5 GiB
}

export const NAIVE: Settings = {
  res: {
    api: { cpuReq: 250, cpuLim: 1000, memReq: 512, memLim: 1024 },
    cache: { cpuReq: 500, cpuLim: 500, memReq: 3072, memLim: 3072 },
    report: { cpuReq: 1000, cpuLim: null, memReq: 1024, memLim: null },
    shipper: { cpuReq: null, cpuLim: null, memReq: null, memLim: null },
    import: { cpuReq: 2000, cpuLim: null, memReq: 4096, memLim: null },
  },
  importOn: false, noisy: false, bigReport: false,
};

/* ---------------- classification ---------------- */

/** The request Kubernetes uses: an unset request with a limit set defaults to the limit. */
export const effReq = (req: number | null, lim: number | null) => req ?? lim ?? 0;

export type Qos = "Guaranteed" | "Burstable" | "BestEffort";
export function qos(r: Res): Qos {
  const cpuR = effReq(r.cpuReq, r.cpuLim), memR = effReq(r.memReq, r.memLim);
  if (r.cpuLim !== null && r.memLim !== null && cpuR === r.cpuLim && memR === r.memLim && cpuR > 0 && memR > 0) return "Guaranteed";
  if (r.cpuReq === null && r.cpuLim === null && r.memReq === null && r.memLim === null) return "BestEffort";
  return "Burstable";
}

export function oomScoreAdj(r: Res): number {
  const q = qos(r);
  if (q === "Guaranteed") return -997;
  if (q === "BestEffort") return 1000;
  return Math.min(Math.max(2, 1000 - Math.floor((1000 * effReq(r.memReq, r.memLim)) / NODE_MEM)), 999);
}

/* ---------------- workloads ---------------- */

/** CPU work of the API in each of the ten 100 ms periods of second t, in ms of CPU time. */
export function apiPeriods(t: number): number[] {
  const spike = t >= 20 && t < 40;
  const small = spike ? 50 : 15, burst = spike ? 260 : 150; // the burst: a GC cycle plus a batch of requests
  return Array.from({ length: 10 }, (_, i) => (i === 3 ? burst : small));
}

function cpuDemand(id: PodId, t: number, s: Settings, age: number): number {
  switch (id) {
    case "api": return apiPeriods(t).reduce((a, b) => a + b, 0); // ms per s = millicores
    case "cache": return 300;
    case "report": return age < REPORT_RUNS ? (s.noisy ? 4000 : 1200) : 0;
    case "shipper": return 150;
    case "import": return 1500;
  }
}

export const REPORT_RUNS = 50;
function memDemand(id: PodId, t: number, s: Settings, age: number): number {
  switch (id) {
    case "api": return t >= 20 && t < 40 ? 800 : 600;
    case "cache": return 2900;
    case "report": {
      if (age >= REPORT_RUNS) return 0;
      const peak = s.bigReport ? 4600 : 3600;
      return Math.round(400 + (peak - 400) * Math.min(1, Math.max(0, age - 5) / 35));
    }
    case "shipper": return 250;
    case "import": return 2500;
  }
}

/* ---------------- the simulation ---------------- */

export type EventKind = "oomkill" | "evict" | "kernel-oom" | "pending" | "done";
export interface Ev { t: number; pod: PodId; kind: EventKind; text: string }
export interface PodSec { cpu: number; cpuWant: number; mem: number; up: boolean; throttled: number; latency: number | null; burst: number | null }
export interface PodRun {
  id: PodId; scheduled: boolean; pendingReason: string | null; qos: Qos; adj: number;
  secs: PodSec[]; restarts: number; evicted: boolean; oomKills: number; kernelKills: number; completed: boolean;
}
export interface Run {
  pods: PodRun[];
  events: Ev[];
  reqCpu: number; reqMem: number;
  peakMem: number;
  /** the API's CPU story, for the result */
  api: { avgCpu: number; throttledPct: number; worst: number; worstAt: number };
}

/** The API's slowest burst in one second: work beyond the quota waits for the next period. */
export function apiLatency(periods: number[], limit: number | null, share: number): { worst: number; throttled: number } {
  const quota = limit === null ? Infinity : (limit / 1000) * PERIOD;
  const rate = THREADS * Math.max(0.05, share); // cores actually available to its threads
  let worst = 0, throttled = 0;
  for (const w of periods) {
    let wall: number;
    if (w <= quota) wall = w / rate;
    else { throttled++; wall = PERIOD + (w - quota) / rate; } // quota spent: every thread waits for the next period
    worst = Math.max(worst, wall);
  }
  return { worst: Math.round(5 + worst), throttled };
}

export function simulate(s: Settings): Run {
  const ids = PODS.filter((p) => p !== "import" || s.importOn);
  const events: Ev[] = [];
  // 1. the scheduler: sums requests, never usage
  let cpu = 0, mem = 0;
  const runs: Record<string, PodRun> = {};
  for (const id of ids) {
    const r = s.res[id];
    const c = effReq(r.cpuReq, r.cpuLim), m = effReq(r.memReq, r.memLim);
    const fitsCpu = cpu + c <= NODE_CPU, fitsMem = mem + m <= NODE_MEM;
    const ok = fitsCpu && fitsMem;
    if (ok) { cpu += c; mem += m; }
    const reason = ok ? null : `0/1 nodes are available: Insufficient ${!fitsCpu && !fitsMem ? "cpu, memory" : !fitsCpu ? "cpu" : "memory"}`;
    if (!ok) events.push({ t: 0, pod: id, kind: "pending", text: `${POD_INFO[id].name} stays Pending. ${reason}.` });
    runs[id] = { id, scheduled: ok, pendingReason: reason, qos: qos(r), adj: oomScoreAdj(r), secs: [], restarts: 0, evicted: false, oomKills: 0, kernelKills: 0, completed: false };
  }
  const live = ids.filter((id) => runs[id].scheduled);
  const started: Record<string, number> = {};
  const downUntil: Record<string, number> = {};
  for (const id of live) { started[id] = 0; downUntil[id] = -1; }
  let peakMem = 0;

  const kill = (id: PodId, t: number) => {
    const p = runs[id];
    p.restarts++;
    downUntil[id] = t + BACKOFF * 2 ** (p.restarts - 1);
    started[id] = downUntil[id]; // the job starts from scratch
  };

  for (let t = 0; t < HORIZON; t++) {
    const up = (id: PodId) => !runs[id].evicted && !runs[id].completed && t >= downUntil[id];
    // memory: own limit first (the container's cgroup), then the node
    const memNow: Record<string, number> = {};
    for (const id of live) {
      if (!up(id)) { memNow[id] = 0; continue; }
      const want = memDemand(id, t, s, t - started[id]);
      if (id === "report" && t - started[id] >= REPORT_RUNS && !runs[id].completed) {
        runs[id].completed = true;
        events.push({ t, pod: id, kind: "done", text: "report finished: exit 0, Completed." });
        memNow[id] = 0; continue;
      }
      const lim = s.res[id].memLim;
      if (lim !== null && want > lim) {
        runs[id].oomKills++;
        events.push({ t, pod: id, kind: "oomkill", text: `${POD_INFO[id].name} needs ${want} Mi, its limit is ${lim} Mi: the kernel kills it inside its own cgroup. OOMKilled, exit 137, restart in ${BACKOFF * 2 ** runs[id].restarts} s.` });
        kill(id, t);
        memNow[id] = 0;
        continue;
      }
      memNow[id] = want;
    }
    // the node: the kernel acts the moment memory runs out; the kubelet only on its periodic check
    while (sumMem(memNow) > NODE_MEM) {
      const victim = live.filter((id) => memNow[id] > 0)
        .sort((a, b) => score(b, memNow[b]) - score(a, memNow[a]))[0];
      runs[victim].kernelKills++;
      events.push({ t, pod: victim, kind: "kernel-oom", text: `The node is out of memory before the kubelet's next check. The kernel's OOM killer picks the highest score: ${POD_INFO[victim].name} (${memNow[victim]} Mi used, oom_score_adj ${runs[victim].adj}). Exit 137, restart.` });
      kill(victim, t);
      memNow[victim] = 0;
    }
    if (t % CHECK_EVERY === 0 && NODE_MEM - sumMem(memNow) < EVICT_BELOW) {
      // kubelet eviction: usage above request first, then the largest excess
      const ranked = live.filter((id) => memNow[id] > 0).map((id) => ({ id, over: memNow[id] - effReq(s.res[id].memReq, s.res[id].memLim) }))
        .sort((a, b) => (b.over > 0 ? 1 : 0) - (a.over > 0 ? 1 : 0) || b.over - a.over);
      const v = ranked[0];
      if (v) {
        runs[v.id].evicted = true;
        events.push({ t, pod: v.id, kind: "evict", text: `memory.available is ${NODE_MEM - sumMem(memNow)} Mi, under ${EVICT_BELOW} Mi. The kubelet evicts ${POD_INFO[v.id].name}: it uses ${v.over > 0 ? `${v.over} Mi more than it requested` : "less than it requested, but nothing else is left"}. The pod is Failed; its controller must place a new one elsewhere.` });
        memNow[v.id] = 0;
      }
    }
    peakMem = Math.max(peakMem, sumMem(memNow));

    // CPU: each container capped by its limit, then shared by request weight when the node is full
    const want: Record<string, number> = {};
    for (const id of live) want[id] = up(id) && memNow[id] > 0 ? cpuDemand(id, t, s, t - started[id]) : 0;
    const capped: Record<string, number> = {};
    for (const id of live) capped[id] = Math.min(want[id], s.res[id].cpuLim ?? Infinity);
    const got = share(live, capped, (id) => Math.max(2, effReq(s.res[id].cpuReq, s.res[id].cpuLim)));
    for (const id of live) {
      const sec: PodSec = { cpu: Math.round(got[id]), cpuWant: Math.round(want[id]), mem: memNow[id], up: memNow[id] > 0, throttled: 0, latency: null, burst: null };
      if (id === "api" && sec.up) {
        // During its burst the API wants all its threads at once; what it gets depends on its neighbours and its weight.
        const burst = share(live, { ...capped, api: THREADS * 1000 }, (x) => Math.max(2, effReq(s.res[x].cpuReq, s.res[x].cpuLim)));
        const l = apiLatency(apiPeriods(t), s.res.api.cpuLim, burst.api / (THREADS * 1000));
        sec.throttled = l.throttled;
        sec.latency = l.worst;
        sec.burst = Math.round(burst.api);
      }
      runs[id].secs.push(sec);
    }
    for (const id of ids.filter((i) => !runs[i].scheduled)) runs[id].secs.push({ cpu: 0, cpuWant: 0, mem: 0, up: false, throttled: 0, latency: null, burst: null });
  }

  const apiSecs = runs.api.secs.filter((x) => x.up);
  const worst = apiSecs.reduce((m, x, i) => ((x.latency ?? 0) > m.v ? { v: x.latency ?? 0, i } : m), { v: 0, i: 0 });
  return {
    pods: ids.map((id) => runs[id]), events, reqCpu: cpu, reqMem: mem, peakMem,
    api: {
      avgCpu: apiSecs.length ? Math.round(apiSecs.reduce((a, x) => a + x.cpu, 0) / apiSecs.length) : 0,
      throttledPct: apiSecs.length ? Math.round((apiSecs.reduce((a, x) => a + x.throttled, 0) / (apiSecs.length * 10)) * 100) : 0,
      worst: worst.v, worstAt: worst.i,
    },
  };

  function score(id: PodId, used: number) { return (used / NODE_MEM) * 1000 + runs[id].adj; }
}

function sumMem(m: Record<string, number>) { return Object.values(m).reduce((a, b) => a + b, 0); }

/** Water-filling: everyone gets what it wants if it fits; otherwise CPU is split by weight (requests). */
function share(ids: PodId[], want: Record<string, number>, weight: (id: PodId) => number): Record<string, number> {
  const got: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  let left = NODE_CPU;
  let open = ids.filter((id) => want[id] > 0);
  while (open.length && left > 0.5) {
    const w = open.reduce((a, id) => a + weight(id), 0);
    let used = 0;
    const still: PodId[] = [];
    for (const id of open) {
      const offer = (left * weight(id)) / w;
      const take = Math.min(offer, want[id] - got[id]);
      got[id] += take; used += take;
      if (want[id] - got[id] > 0.5) still.push(id);
    }
    left -= used;
    if (still.length === open.length && used < 0.5) break;
    open = still;
  }
  return got;
}

/* ---------------- the playground's state ---------------- */

export interface Goals { pending: boolean; throttledLow: boolean; ownLimit: boolean; evicted: boolean; protectedReport: boolean; contention: boolean }
export interface State { settings: Settings; run: Run | null; found: Goals }
export type Action =
  | { type: "res"; pod: PodId; field: keyof Res; value: number | null }
  | { type: "toggle"; key: "importOn" | "noisy" | "bigReport"; on: boolean }
  | { type: "run" }
  | { type: "reset" };

export function init(): State {
  return { settings: structuredCloneSettings(NAIVE), run: null, found: { pending: false, throttledLow: false, ownLimit: false, evicted: false, protectedReport: false, contention: false } };
}

function structuredCloneSettings(s: Settings): Settings {
  return { ...s, res: Object.fromEntries(PODS.map((p) => [p, { ...s.res[p] }])) as Record<PodId, Res> };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "res": {
      const settings = structuredCloneSettings(st.settings);
      const v = a.value === null ? null : Math.max(0, Math.round(a.value));
      settings.res[a.pod] = { ...settings.res[a.pod], [a.field]: v };
      const next = { ...st, settings };
      return st.run ? runIt(next) : next;
    }
    case "toggle": {
      const next = { ...st, settings: { ...st.settings, [a.key]: a.on } };
      return st.run ? runIt(next) : next;
    }
    case "run": return runIt(st);
  }
}

function runIt(st: State): State {
  const run = simulate(st.settings);
  const f = { ...st.found };
  const api = run.pods.find((p) => p.id === "api")!;
  const lim = st.settings.res.api.cpuLim;
  if (run.pods.some((p) => !p.scheduled) && run.pods.reduce((a, p) => a + p.secs[0].mem, 0) < NODE_MEM * 0.75) f.pending = true;
  if (lim !== null && run.api.throttledPct > 0 && run.api.avgCpu < lim / 2) f.throttledLow = true;
  if (run.events.some((e) => e.kind === "oomkill")) f.ownLimit = true;
  if (run.events.some((e) => e.kind === "evict" || e.kind === "kernel-oom")) f.evicted = true;
  const report = run.pods.find((p) => p.id === "report")!;
  if (st.settings.bigReport && report.scheduled && report.completed && !report.evicted && report.restarts === 0 && run.events.some((e) => e.kind === "evict" || e.kind === "kernel-oom")) f.protectedReport = true;
  if (st.settings.noisy && api.secs.some((x) => x.up && x.burst !== null && x.burst < (THREADS * 1000) / 2)) f.contention = true;
  return { ...st, run, found: f };
}

export const CHALLENGES: { id: keyof Goals; text: string }[] = [
  { id: "throttledLow", text: "Find the API throttled while its average CPU is under half its limit." },
  { id: "ownLimit", text: "Get a container OOMKilled by its own limit while the node has memory to spare." },
  { id: "pending", text: "Add the import and get it stuck Pending on a node that is mostly idle." },
  { id: "evicted", text: "Make the node run out of memory. Who goes first, and why?" },
  { id: "protectedReport", text: "With the big report, make something else go instead of the report." },
  { id: "contention", text: "Turn on the noisy neighbour: the API's bursts get less than half its threads. Then win some back with its request." },
];
