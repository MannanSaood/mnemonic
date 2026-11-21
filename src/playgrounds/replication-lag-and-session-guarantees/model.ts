// Replication lag playground: a leader, two async followers, and one user with a laptop and a phone.
//
// After this, the reader can answer: why does a refresh right after Save sometimes show the old
// value, or show the new one and then the old one again, and which routing rule fixes which of the
// two (read-your-writes vs monotonic reads)?
//
// Time is in whole seconds. Every Save or Refresh takes one second. The leader applies a write at
// once; each follower applies the leader's log in order, `lag` seconds after the write (and never
// before the previous entry, because a follower replays the log in order).
//
// The same session is replayed under all four read-routing rules at once, so the reader can compare
// them on identical traffic (a counterfactual), while the timeline shows the rule they selected.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Node = "leader" | "f1" | "f2";
export type Follower = "f1" | "f2";
export type Device = "laptop" | "phone";
export type Policy = "any" | "window" | "sticky" | "token";

export const POLICIES: Policy[] = ["any", "window", "sticky", "token"];
export const FOLLOWERS: Follower[] = ["f1", "f2"];
export const DEVICES: Device[] = ["laptop", "phone"];
/** "Read from the leader for this many seconds after your own write." */
export const WINDOW = 3;
export const MAX_LAG = 8;
/** Sticky routing pins each device's session to one follower (by hashing the session id). */
export const STICKY: Record<Device, Follower> = { laptop: "f1", phone: "f2" };

export const INITIAL_NAME = "Sam Lee";
const NAMES = ["Sam Lee-Park", "Samantha Lee-Park", "Sam L. Park", "Samantha Park", "S. Park", "Sam Park"];

export interface Entry { lsn: number; t: number; value: string; device: Device; arrive: Record<Follower, number> }

export interface Read {
  id: number;
  t: number;
  device: Device;
  node: Node;
  lsn: number;
  value: string;
  /** The user's own newest write was missing. */
  ryw: boolean;
  /** This device had already seen something newer. */
  mono: boolean;
}

export interface Session { lastWriteT: number | null; token: number }
export interface Run {
  rr: number;
  sessions: Record<Device, Session>;
  seen: Record<Device, number>;
  reads: Read[];
  ryw: number;
  mono: number;
  leaderReads: number;
}

export type Challenge = "vanish" | "backwards" | "window" | "sticky" | "device";

export interface State {
  t: number;
  lags: Record<Follower, number>;
  entries: Entry[];
  /** The user's newest write, from any device. */
  userLsn: number;
  /** Where the token and the last-write time live: in each device's cookie, or on the server per user. */
  perUser: boolean;
  view: Policy;
  runs: Record<Policy, Run>;
  nextId: number;
  done: Challenge[];
}

export type Action =
  | { type: "save"; device: Device }
  | { type: "refresh"; device: Device }
  | { type: "wait"; seconds: number }
  | { type: "lag"; follower: Follower; seconds: number }
  | { type: "perUser"; on: boolean }
  | { type: "view"; policy: Policy }
  | { type: "reset" };

const session = (): Session => ({ lastWriteT: null, token: 0 });
const run = (): Run => ({ rr: 0, sessions: { laptop: session(), phone: session() }, seen: { laptop: 0, phone: 0 }, reads: [], ryw: 0, mono: 0, leaderReads: 0 });

export function init(): State {
  return {
    t: 0, lags: { f1: 1, f2: 4 }, entries: [], userLsn: 0, perUser: false, view: "any",
    runs: { any: run(), window: run(), sticky: run(), token: run() }, nextId: 1, done: [],
  };
}

/** Highest log position a node has applied at time t. 0 is the starting row. */
export function applied(st: State, node: Node, t = st.t): number {
  let lsn = 0;
  for (const e of st.entries) {
    const at = node === "leader" ? e.t : e.arrive[node];
    if (at <= t) lsn = e.lsn;
    else break; // applied in log order
  }
  return lsn;
}

export const valueAt = (st: State, lsn: number) => (lsn === 0 ? INITIAL_NAME : st.entries[lsn - 1].value);

/** Seconds a follower is behind the leader right now (0 when caught up). */
export function behind(st: State, f: Follower): number {
  const lead = applied(st, "leader"), mine = applied(st, f);
  if (mine >= lead) return 0;
  return st.t - st.entries[mine].t; // age of the oldest write it is missing
}

const key = (st: State, d: Device): Device => (st.perUser ? "laptop" : d);

/** Which node serves a read under a routing rule. Returns the node and the updated round-robin counter. */
export function route(st: State, r: Run, p: Policy, d: Device): { node: Node; rr: number } {
  const rotate = (): Follower => (r.rr % 2 === 0 ? "f1" : "f2");
  const s = r.sessions[key(st, d)];
  switch (p) {
    case "any":
      return { node: rotate(), rr: r.rr + 1 };
    case "window":
      if (s.lastWriteT !== null && st.t - s.lastWriteT < WINDOW) return { node: "leader", rr: r.rr };
      return { node: rotate(), rr: r.rr + 1 };
    case "sticky":
      return { node: STICKY[d], rr: r.rr };
    case "token": {
      const order: Follower[] = r.rr % 2 === 0 ? ["f1", "f2"] : ["f2", "f1"];
      const ok = order.find((f) => applied(st, f) >= s.token);
      return ok ? { node: ok, rr: r.rr + 1 } : { node: "leader", rr: r.rr };
    }
  }
}

function readIn(st: State, p: Policy, d: Device, id: number): Run {
  const r = st.runs[p];
  const { node, rr } = route(st, r, p, d);
  const lsn = applied(st, node);
  const read: Read = { id, t: st.t, device: d, node, lsn, value: valueAt(st, lsn), ryw: lsn < st.userLsn, mono: lsn < r.seen[d] };
  const k = key(st, d);
  return {
    ...r, rr,
    seen: { ...r.seen, [d]: Math.max(r.seen[d], lsn) },
    sessions: { ...r.sessions, [k]: { ...r.sessions[k], token: Math.max(r.sessions[k].token, lsn) } },
    reads: [...r.reads, read],
    ryw: r.ryw + (read.ryw ? 1 : 0),
    mono: r.mono + (read.mono ? 1 : 0),
    leaderReads: r.leaderReads + (node === "leader" ? 1 : 0),
  };
}

function writeIn(st: State, r: Run, d: Device, lsn: number): Run {
  const k = key(st, d);
  return { ...r, sessions: { ...r.sessions, [k]: { lastWriteT: st.t, token: lsn } } };
}

function challenges(st: State): Challenge[] {
  const got = new Set(st.done);
  const R = st.runs;
  if (R.any.ryw) got.add("vanish");
  if (R.any.reads.some((x) => x.mono)) got.add("backwards");
  if (R.window.ryw) got.add("window");
  if (R.sticky.ryw) got.add("sticky");
  if (R.token.ryw) got.add("device");
  return (["vanish", "backwards", "window", "sticky", "device"] as Challenge[]).filter((c) => got.has(c));
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "view":
      return { ...st, view: a.policy };
    case "perUser":
      return { ...st, perUser: a.on };
    case "lag":
      return { ...st, lags: { ...st.lags, [a.follower]: Math.max(0, Math.min(MAX_LAG, a.seconds)) } };
    case "wait":
      return { ...st, t: st.t + Math.max(1, a.seconds) };
    case "save": {
      const lsn = st.entries.length + 1;
      const prev = st.entries[st.entries.length - 1];
      const arrive = {
        f1: Math.max(prev?.arrive.f1 ?? 0, st.t + st.lags.f1),
        f2: Math.max(prev?.arrive.f2 ?? 0, st.t + st.lags.f2),
      };
      const value = NAMES[(lsn - 1) % NAMES.length];
      const entries = [...st.entries, { lsn, t: st.t, value, device: a.device, arrive }];
      const next: State = { ...st, entries, userLsn: lsn };
      const runs = Object.fromEntries(POLICIES.map((p) => [p, writeIn(next, st.runs[p], a.device, lsn)])) as Record<Policy, Run>;
      return { ...next, runs, t: st.t + 1 };
    }
    case "refresh": {
      const id = st.nextId;
      const runs = Object.fromEntries(POLICIES.map((p) => [p, readIn(st, p, a.device, id)])) as Record<Policy, Run>;
      const next = { ...st, runs, nextId: id + 1, t: st.t + 1 };
      return { ...next, done: challenges(next) };
    }
  }
}

/** What a device's screen shows under a rule: its newest read or write. */
export function screen(st: State, p: Policy, d: Device): { value: string; lsn: number; from: Node | "save" } {
  const r = st.runs[p];
  const reads = r.reads.filter((x) => x.device === d);
  const last = reads[reads.length - 1];
  const lastWrite = [...st.entries].reverse().find((e) => e.device === d);
  if (lastWrite && (!last || lastWrite.t >= last.t)) return { value: lastWrite.value, lsn: lastWrite.lsn, from: "save" };
  if (last) return { value: last.value, lsn: last.lsn, from: last.node };
  return { value: INITIAL_NAME, lsn: 0, from: "leader" };
}

export const totals = (st: State) => ({
  saves: st.entries.length,
  reads: st.runs.any.reads.length,
});
