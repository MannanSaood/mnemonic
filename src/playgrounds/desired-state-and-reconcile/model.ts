// Desired state and the reconcile loop: two copies of the same small cluster (three nodes, a
// pool of worker pods) receive exactly the same disturbances. One is kept alive by an
// edge-triggered script (create N pods, then "on DELETED, create one"; on a spec change, create
// or delete the difference from the count it remembers). The other by a level-triggered reconcile
// loop (on any wake-up: list the pods, compare with spec.replicas, create or delete the gap).
// The reader edits spec.replicas, deletes pods, kills and restores nodes, stops the controllers
// and drops the watch, and watches observed state converge, or not.
//
// After this, the reader can answer: why does a Kubernetes controller compare desired and
// observed state on every pass instead of reacting to each event? (Events get lost: a dropped
// watch, a restarted controller, a pod that never reports DELETED because its node is gone. A
// loop that acts on the present difference repairs all of them on its next pass; a handler that
// acts on events stays wrong until another event happens to fix it, short or over.)
//
// Timings follow the Kubernetes docs, simplified: a node that stops reporting is marked NotReady
// after node-monitor-grace-period (50 s), and its pods are evicted after the default 300 s
// toleration for node.kubernetes.io/unreachable. Evicted pods on a dead node stay Terminating
// until the kubelet comes back, so no DELETED event arrives. A ReplicaSet does not count pods
// that are being deleted, and on scale-down removes unscheduled and pending pods first, then
// pods on the most crowded node, then the newest. Units are seconds. Pure state + step, tested.

export const NODES = ["node-a", "node-b", "node-c"] as const;
export const START = 3;            // create -> Running
export const TERM = 2;             // graceful termination when the kubelet is alive
export const NOT_READY_AFTER = 50; // node-monitor-grace-period
export const EVICT_AFTER = 300;    // default tolerationSeconds for unreachable / not-ready
export const MAX_REPLICAS = 8;

export type Side = "script" | "loop";
export const SIDES: Side[] = ["script", "loop"];
export const SIDE_INFO: Record<Side, { name: string; how: string }> = {
  script: { name: "Event script", how: "edge-triggered: acts on each event it sees" },
  loop: { name: "Reconcile loop", how: "level-triggered: compares desired with observed" },
};

export type Phase = "Pending" | "Running" | "Terminating";
export interface Pod { name: string; node: number | null; phase: Phase; since: number; createdAt: number }

export type Ev =
  | { kind: "spec"; replicas: number }
  | { kind: "deleted"; pod: string }
  | { kind: "changed"; pod: string };

export interface Entry { n: number; t: number; text: string; tone: "ok" | "bad" | "info" }

export interface Lane {
  pods: Pod[];
  seq: number;
  inbox: Ev[];
  /** script only: the replica count it remembers, and the pods it knows it created / deleted itself */
  want: number;
  known: string[];
  selfDeleted: string[];
  /** loop only: it was disconnected and must re-list before trusting its cache */
  stale: boolean;
  writes: number;
  missed: number;
  /** pod-seconds below spec.replicas (ready pods), and above it (active pods) */
  short: number;
  extra: number;
  log: Entry[];
  /** seconds from the first node failure until this side was back at spec.replicas ready, on a live node */
  recoveredAfter: number | null;
}

export interface Outage { kind: "stopped" | "watch"; deletes: number; specChanged: boolean }

export interface Goals { replaced: boolean; stopped: boolean; watch: boolean; node: boolean; overshoot: boolean }

export interface State {
  t: number;
  replicas: number;
  nodes: { alive: boolean; deadAt: number | null }[];
  running: boolean;
  watch: boolean;
  lanes: Record<Side, Lane>;
  logSeq: number;
  outage: Outage | null;
  lastOutage: Outage | null;
  readerDeleted: boolean;
  nodeDeadAt: number | null;
  found: Goals;
}

export type Action =
  | { type: "tick"; seconds: number }
  | { type: "replicas"; value: number }
  | { type: "deletePod"; side: Side; name: string }
  | { type: "node"; index: number }
  | { type: "controllers"; on: boolean }
  | { type: "watch"; on: boolean }
  | { type: "reset" };

/* ---------------- setup ---------------- */

function freshLane(): Lane {
  const pods: Pod[] = [0, 1, 2].map((i) => ({ name: `worker-${i + 1}`, node: i, phase: "Running", since: -10, createdAt: -10 + i }));
  return {
    pods, seq: 3, inbox: [], want: 3, known: pods.map((p) => p.name), selfDeleted: [], stale: false,
    writes: 0, missed: 0, short: 0, extra: 0, log: [], recoveredAfter: null,
  };
}

export function init(): State {
  return {
    t: 0, replicas: 3,
    nodes: NODES.map(() => ({ alive: true, deadAt: null })),
    running: true, watch: true,
    lanes: { script: freshLane(), loop: freshLane() },
    logSeq: 0, outage: null, lastOutage: null, readerDeleted: false, nodeDeadAt: null,
    found: { replaced: false, stopped: false, watch: false, node: false, overshoot: false },
  };
}

/* ---------------- queries ---------------- */

export const active = (l: Lane) => l.pods.filter((p) => p.phase !== "Terminating");
export const nodeAlive = (s: State, n: number | null) => n !== null && s.nodes[n].alive;
/** Pods that would actually serve: Running on a node whose kubelet is alive. */
export const ready = (s: State, l: Lane) => l.pods.filter((p) => p.phase === "Running" && nodeAlive(s, p.node)).length;
export const connected = (s: State) => s.running && s.watch;
export const atDesired = (s: State, l: Lane) => active(l).length === s.replicas && ready(s, l) === s.replicas;
/** What the API server shows for a pod: a pod on a node gone silent for 50 s reads Unknown. */
export function podStatus(s: State, p: Pod): string {
  if (p.phase === "Terminating") return "Terminating";
  if (p.node === null) return "Pending";
  const n = s.nodes[p.node];
  if (!n.alive && n.deadAt !== null && s.t - n.deadAt >= NOT_READY_AFTER) return "Unknown";
  return p.phase === "Pending" ? "ContainerCreating" : "Running";
}

/* ---------------- helpers (mutate a cloned state) ---------------- */

function clone(s: State): State {
  const lane = (l: Lane): Lane => ({ ...l, pods: l.pods.map((p) => ({ ...p })), inbox: [...l.inbox], known: [...l.known], selfDeleted: [...l.selfDeleted], log: [...l.log] });
  return { ...s, nodes: s.nodes.map((n) => ({ ...n })), lanes: { script: lane(s.lanes.script), loop: lane(s.lanes.loop) }, found: { ...s.found }, outage: s.outage ? { ...s.outage } : null };
}

function say(s: State, side: Side, text: string, tone: Entry["tone"] = "info") {
  const l = s.lanes[side];
  l.log = [{ n: ++s.logSeq, t: s.t, text, tone }, ...l.log].slice(0, 8);
}

function schedule(s: State, l: Lane): number | null {
  let best: number | null = null;
  let bestLoad = Infinity;
  s.nodes.forEach((n, i) => {
    if (!n.alive) return;
    const load = l.pods.filter((p) => p.node === i && p.phase !== "Terminating").length;
    if (load < bestLoad) { best = i; bestLoad = load; }
  });
  return best;
}

function create(s: State, side: Side): string {
  const l = s.lanes[side];
  const name = `worker-${++l.seq}`;
  l.pods.push({ name, node: schedule(s, l), phase: "Pending", since: s.t, createdAt: s.t });
  l.writes++;
  l.inbox.push({ kind: "changed", pod: name });
  if (side === "script") l.known.push(name);
  return name;
}

/** Mark a pod for deletion. Returns false if it is already gone or going. */
function remove(s: State, side: Side, name: string): boolean {
  const l = s.lanes[side];
  const p = l.pods.find((x) => x.name === name);
  if (!p || p.phase === "Terminating") return false;
  if (p.node === null) {
    l.pods = l.pods.filter((x) => x !== p); // never scheduled: nothing to stop
    l.inbox.push({ kind: "deleted", pod: name });
    return true;
  }
  p.phase = "Terminating";
  p.since = s.t;
  l.inbox.push({ kind: "changed", pod: name });
  return true;
}

/** ReplicaSet's scale-down order: unscheduled, then pending, then the most crowded node, then the newest. */
export function deletionOrder(l: Lane): Pod[] {
  const act = active(l);
  const load = (n: number | null) => act.filter((p) => p.node === n).length;
  const rank = (p: Pod) => (p.node === null ? 0 : p.phase === "Pending" ? 1 : 2);
  return [...act].sort((a, b) => rank(a) - rank(b) || load(b.node) - load(a.node) || b.createdAt - a.createdAt);
}

/* ---------------- the two controllers ---------------- */

function loopPass(s: State, why: string) {
  const l = s.lanes.loop;
  const have = active(l).length;
  const diff = s.replicas - have;
  if (diff > 0) {
    const made = Array.from({ length: diff }, () => create(s, "loop"));
    say(s, "loop", `${why}: observed ${have}, desired ${s.replicas}. Create ${made.join(", ")}.`, "ok");
  } else if (diff < 0) {
    const gone = deletionOrder(l).slice(0, -diff).map((p) => p.name);
    for (const n of gone) { remove(s, "loop", n); l.writes++; }
    say(s, "loop", `${why}: observed ${have}, desired ${s.replicas}. Delete ${gone.join(", ")}.`, "ok");
  } else if (why.startsWith("Re-list")) {
    say(s, "loop", `${why}: observed ${have}, desired ${s.replicas}. Nothing to do.`, "info");
  }
}

function scriptHandle(s: State, ev: Ev) {
  const l = s.lanes.script;
  if (ev.kind === "changed") return; // it only listens for DELETED and spec changes
  if (ev.kind === "deleted") {
    if (l.selfDeleted.includes(ev.pod)) { l.selfDeleted = l.selfDeleted.filter((x) => x !== ev.pod); return; }
    if (!l.known.includes(ev.pod)) return;
    const name = create(s, "script");
    say(s, "script", `DELETED ${ev.pod}: start one more, ${name}.`, "ok");
    return;
  }
  const delta = ev.replicas - l.want;
  if (delta > 0) {
    const made = Array.from({ length: delta }, () => create(s, "script"));
    say(s, "script", `replicas ${l.want} → ${ev.replicas}: create ${made.join(", ")}.`, "ok");
  } else if (delta < 0) {
    // It deletes the newest pods it remembers creating, whether or not they still exist.
    const mine = l.known.filter((n) => !l.selfDeleted.includes(n)).slice(delta);
    const missing: string[] = [];
    for (const n of mine) {
      l.writes++;
      if (remove(s, "script", n)) l.selfDeleted.push(n); else missing.push(n);
      l.known = l.known.filter((x) => x !== n);
    }
    say(s, "script", `replicas ${l.want} → ${ev.replicas}: delete ${mine.join(", ")}${missing.length ? ` (${missing.join(", ")}: 404, already gone)` : ""}.`, missing.length ? "bad" : "ok");
  }
  l.want = ev.replicas;
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "tick": {
      let s = st;
      for (let i = 0; i < Math.max(1, Math.min(60, a.seconds)); i++) s = tick(s);
      return s;
    }
    case "replicas": {
      const v = Math.max(0, Math.min(MAX_REPLICAS, Math.round(a.value)));
      if (v === st.replicas) return st;
      const s = clone(st);
      s.replicas = v;
      for (const side of SIDES) s.lanes[side].inbox.push({ kind: "spec", replicas: v });
      if (s.outage) s.outage.specChanged = true;
      return s;
    }
    case "deletePod": {
      const s = clone(st);
      const here = s.lanes[a.side].pods.find((p) => p.name === a.name);
      if (!here || here.phase === "Terminating") return st;
      remove(s, a.side, a.name);
      // The same disturbance on the other side: the same pod if it exists, else one on the same node.
      const other: Side = a.side === "script" ? "loop" : "script";
      const ol = s.lanes[other];
      const twin = active(ol).find((p) => p.name === a.name) ?? active(ol).find((p) => p.node === here.node) ?? active(ol)[0];
      if (twin) remove(s, other, twin.name);
      s.readerDeleted = true;
      if (s.outage) s.outage.deletes++;
      return s;
    }
    case "node": {
      const n = st.nodes[a.index];
      if (!n) return st;
      const s = clone(st);
      if (n.alive) {
        s.nodes[a.index] = { alive: false, deadAt: s.t };
        if (s.nodeDeadAt === null) s.nodeDeadAt = s.t;
        for (const side of SIDES) say(s, side, `${NODES[a.index]} stops answering. Its pods still look Running in the API.`, "bad");
      } else {
        s.nodes[a.index] = { alive: true, deadAt: null };
        for (const side of SIDES) say(s, side, `${NODES[a.index]} is back. Its kubelet finishes any deletions it missed.`, "info");
        // Terminating pods on it can now finish; their timers restart.
        for (const side of SIDES) for (const p of s.lanes[side].pods) if (p.node === a.index && p.phase === "Terminating") p.since = s.t;
      }
      return s;
    }
    case "controllers": {
      if (st.running === a.on) return st;
      const s = clone(st);
      s.running = a.on;
      toggleConnection(s, a.on, "stopped");
      if (a.on) {
        // The script restarts: it reads spec.replicas as its new baseline and watches from now.
        const l = s.lanes.script;
        l.want = s.replicas;
        say(s, "script", `Restarted. Reads replicas = ${s.replicas} and watches from now. Pods it missed are not its business.`, "bad");
      } else {
        for (const side of SIDES) say(s, side, "Controller stopped.", "bad");
      }
      return s;
    }
    case "watch": {
      if (st.watch === a.on) return st;
      const s = clone(st);
      s.watch = a.on;
      toggleConnection(s, a.on, "watch");
      if (a.on) say(s, "script", "Watch re-opened from now. Events sent while it was down are gone.", "bad");
      else for (const side of SIDES) say(s, side, "Watch connection dropped.", "bad");
      return s;
    }
  }
}

function toggleConnection(s: State, on: boolean, kind: Outage["kind"]) {
  if (!on) {
    s.lanes.loop.stale = true;
    if (!s.outage) s.outage = { kind, deletes: 0, specChanged: false };
  } else if (connected(s) && s.outage) {
    s.lastOutage = s.outage;
    s.outage = null;
  }
}

function tick(st: State): State {
  const s = clone(st);
  s.t += 1;
  // 1. kubelets and the scheduler
  for (const side of SIDES) {
    const l = s.lanes[side];
    const keep: Pod[] = [];
    for (const p of l.pods) {
      if (p.node === null && p.phase === "Pending") {
        p.node = schedule(s, l);
        if (p.node !== null) p.since = s.t;
      }
      const live = nodeAlive(s, p.node);
      if (p.phase === "Pending" && live && s.t - p.since >= START) {
        p.phase = "Running";
        l.inbox.push({ kind: "changed", pod: p.name });
      }
      if (p.phase === "Terminating" && live && s.t - p.since >= TERM) {
        l.inbox.push({ kind: "deleted", pod: p.name });
        continue;
      }
      keep.push(p);
    }
    l.pods = keep;
  }
  // 2. the node lifecycle controller (it runs in both copies of the cluster)
  s.nodes.forEach((n, i) => {
    if (n.alive || n.deadAt === null) return;
    const gone = s.t - n.deadAt;
    if (gone === NOT_READY_AFTER) for (const side of SIDES) say(s, side, `${NODES[i]} marked NotReady after ${NOT_READY_AFTER} s of silence. Its pods show Unknown.`, "info");
    if (gone === NOT_READY_AFTER + EVICT_AFTER) {
      for (const side of SIDES) {
        const victims = active(s.lanes[side]).filter((p) => p.node === i);
        for (const p of victims) remove(s, side, p.name);
        if (victims.length) say(s, side, `After the ${EVICT_AFTER} s toleration, ${victims.map((p) => p.name).join(", ")} are evicted. They stay Terminating: no kubelet is left to confirm.`, "info");
      }
    }
  });
  // 3. watch delivery and the controllers
  const up = connected(s);
  for (const side of SIDES) {
    const l = s.lanes[side];
    const evs = l.inbox;
    l.inbox = [];
    if (!up) {
      if (side === "script") l.missed += evs.filter((e) => e.kind !== "changed").length;
      continue;
    }
    if (side === "script") for (const e of evs) scriptHandle(s, e);
    else if (l.stale) { l.stale = false; loopPass(s, "Re-list after reconnecting"); }
    else if (evs.length) {
      const e = evs.find((x) => x.kind === "spec") ?? evs.find((x) => x.kind === "deleted") ?? evs[0];
      loopPass(s, e.kind === "spec" ? "Woken by a spec change" : `Woken by ${e.kind === "deleted" ? "DELETED" : "a change to"} ${e.pod}`);
    }
  }
  // 4. metrics
  for (const side of SIDES) {
    const l = s.lanes[side];
    l.short += Math.max(0, s.replicas - ready(s, l));
    l.extra += Math.max(0, active(l).length - s.replicas);
    if (s.nodeDeadAt !== null && l.recoveredAfter === null && s.t > s.nodeDeadAt && atDesired(s, l)) {
      // only counts once a pod had to be replaced
      const onDead = l.pods.some((p) => p.node !== null && !s.nodes[p.node].alive);
      const anyDead = s.nodes.some((n) => !n.alive);
      if (anyDead && onDead) l.recoveredAfter = s.t - s.nodeDeadAt;
    }
  }
  check(s);
  return s;
}

/* ---------------- what the reader found ---------------- */

function check(s: State) {
  const sc = s.lanes.script, lp = s.lanes.loop;
  const f = s.found;
  if (s.readerDeleted && atDesired(s, sc) && atDesired(s, lp) && s.t > 0) f.replaced = true;
  const o = s.lastOutage;
  if (o && connected(s) && atDesired(s, lp) && !atDesired(s, sc)) {
    if (o.kind === "stopped" && (o.deletes > 0 || o.specChanged)) f.stopped = true;
    if (o.kind === "watch" && (o.deletes > 0 || o.specChanged)) f.watch = true;
  }
  if (lp.recoveredAfter !== null) f.node = true;
  if (connected(s) && atDesired(s, lp) && active(sc).length > s.replicas) f.overshoot = true;
}

export const CHALLENGES: { id: keyof Goals; text: string }[] = [
  { id: "replaced", text: "Delete a pod. Both sides replace it: when nothing is lost, events and levels agree." },
  { id: "stopped", text: "Stop the controllers, delete pods or change replicas, start them again. Only one side recovers." },
  { id: "watch", text: "Drop the watch, change replicas, reconnect. The script never hears about it." },
  { id: "node", text: "Kill a node and time how long the loop takes to replace its pods. Does the script ever?" },
  { id: "overshoot", text: "Make the script run more pods than spec.replicas asks for, while the loop is exact." },
];
