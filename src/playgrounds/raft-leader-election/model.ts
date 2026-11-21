// Raft leader election playground: five servers exchanging RequestVote and AppendEntries
// (heartbeat) messages over links with a little latency. The reader kills and restarts servers,
// partitions the network, heals it, and changes how random the election timeouts are, while
// the simulation runs in slow motion. Terms, votes, timers and messages are all visible.
//
// After this, the reader can answer: "How does Raft pick exactly one leader per term, why are
// the election timeouts random, and why can a side of a partition without a majority never
// elect one?"
// Core insight: a candidate needs votes from a majority (3 of 5), and each server votes once
// per term, so at most one leader per term. Random timeouts let one server usually start first
// and win before others wake; equal timeouts make everyone stand at once and split the vote.
// A minority keeps timing out and raising its term but can never win, and a stale leader
// steps down the moment it sees a higher term.
//
// Modelled on section 5.2 of the Raft paper (Ongaro and Ousterhout, 2014). Log comparison in
// RequestVote is left out: every server's log is the same here, so it never changes a vote.

export const N = 5;
export const MAJORITY = Math.floor(N / 2) + 1;
export const HEARTBEAT = 50;
export type Role = "follower" | "candidate" | "leader";
export type TimeoutMode = "wide" | "narrow" | "fixed";
export const TIMEOUT_LABEL: Record<TimeoutMode, string> = { wide: "150–300 ms", narrow: "150–175 ms", fixed: "150 ms, no randomness" };
export type Partition = "none" | "leader-in-minority" | "leader-in-majority";

export interface Server {
  id: number;
  alive: boolean;
  role: Role;
  term: number;
  votedFor: number | null;
  votes: number[];
  /** ms left before this server's election timeout fires (followers and candidates). */
  timer: number;
  /** The timeout it drew last, for drawing the timer ring. */
  timeout: number;
  /** ms until the next heartbeat (leaders). */
  hb: number;
  leaderId: number | null;
  /** Which side of the partition it is on. */
  side: 0 | 1;
  /** It became leader while its side had no majority, or lost its majority while leading. */
  isolatedLeader: boolean;
}

export type MsgKind = "vote-req" | "vote" | "append" | "append-reply";
export interface Msg { id: number; from: number; to: number; kind: MsgKind; term: number; granted?: boolean; sentAt: number; deliverAt: number }

export interface LogEvent { n: number; t: number; text: string; tone: "ok" | "bad" | "info" }

export interface State {
  now: number;
  servers: Server[];
  msgs: Msg[];
  seed: number;
  mode: TimeoutMode;
  partition: Partition;
  msgSeq: number;
  log: LogEvent[];
  logSeq: number;
  /** Per term: who stood, and who won. */
  terms: Record<number, { candidates: number[]; winner: number | null; failed: boolean }>;
  elections: number;
  splitVotes: number;
  /** ms with no leader that a majority can reach. */
  leaderless: number;
  /** Current stretch without a usable leader. */
  leaderlessRun: number;
  /** When the last usable leader was killed or cut off, to time the failover. */
  lostLeaderAt: number | null;
  failovers: number[];
  /** Term on the minority side when the partition began, to see it climb. */
  minorityStartTerm: number | null;
  flags: { replaced: boolean; minorityClimb: boolean; deposed: boolean; twoLeaders: boolean; noQuorum: boolean };
  prediction: string | null;
}

export type Action =
  | { type: "tick"; ms: number }
  | { type: "kill"; id: number }
  | { type: "revive"; id: number }
  | { type: "partition"; kind: Partition }
  | { type: "setMode"; mode: TimeoutMode }
  | { type: "predict"; value: string }
  | { type: "reset" };

/* ---------------- randomness and latency ---------------- */

function next(seed: number): [number, number] {
  let t = (seed + 0x6d2b79f5) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), t | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return [((x ^ (x >>> 14)) >>> 0) / 4294967296, t];
}

function drawTimeout(s: State): number {
  const [r, seed] = next(s.seed);
  s.seed = seed;
  if (s.mode === "fixed") return 150;
  return Math.round(150 + r * (s.mode === "wide" ? 150 : 25));
}

/** One-way latency per link: 15 to 21 ms, fixed per pair. */
export const latency = (a: number, b: number) => 15 + ((a + b) % 3) * 3;

/* ---------------- setup ---------------- */

export function init(): State {
  const s: State = {
    now: 0, servers: [], msgs: [], seed: 42, mode: "wide", partition: "none", msgSeq: 1, log: [], logSeq: 1,
    terms: { 1: { candidates: [0], winner: 0, failed: false } }, elections: 1, splitVotes: 0, leaderless: 0, leaderlessRun: 0,
    lostLeaderAt: null, failovers: [], minorityStartTerm: null,
    flags: { replaced: false, minorityClimb: false, deposed: false, twoLeaders: false, noQuorum: false },
    prediction: null,
  };
  for (let id = 0; id < N; id++) {
    const timeout = drawTimeout(s);
    s.servers.push({ id, alive: true, role: id === 0 ? "leader" : "follower", term: 1, votedFor: 0, votes: id === 0 ? [0, 1, 2] : [], timer: timeout, timeout, hb: 0, leaderId: 0, side: 0, isolatedLeader: false });
  }
  addLog(s, "S1 leads term 1. It sends a heartbeat every 50 ms; each heartbeat resets the followers' election timers.", "info");
  return s;
}

export const name = (id: number) => `S${id + 1}`;

function addLog(s: State, text: string, tone: LogEvent["tone"]) {
  s.log = [{ n: s.logSeq++, t: s.now, text, tone }, ...s.log].slice(0, 14);
}

const reachable = (s: State, a: number, b: number) => s.servers[a].side === s.servers[b].side;
/** Alive servers on the same side as `id`, including itself. */
export const sideSize = (s: State, id: number) => s.servers.filter((x) => x.alive && x.side === s.servers[id].side).length;

/** A leader that can actually get things done: alive, and its side has a majority. */
export function usableLeader(s: State): Server | null {
  return s.servers.find((x) => x.alive && x.role === "leader" && sideSize(s, x.id) >= MAJORITY) ?? null;
}

/* ---------------- protocol ---------------- */

function send(s: State, from: number, to: number, kind: MsgKind, term: number, granted?: boolean) {
  if (!reachable(s, from, to)) return; // dropped by the partition
  s.msgs.push({ id: s.msgSeq++, from, to, kind, term, granted, sentAt: s.now, deliverAt: s.now + latency(from, to) });
}

function becomeFollower(s: State, x: Server, term: number) {
  if (x.role === "leader" && term > x.term) {
    addLog(s, `${name(x.id)} sees term ${term}, higher than its own ${x.term}, and steps down.`, "info");
    if (x.isolatedLeader) s.flags.deposed = true;
  }
  x.role = "follower";
  x.term = term;
  x.votedFor = null;
  x.votes = [];
  x.isolatedLeader = false;
}

function resetTimer(s: State, x: Server) {
  x.timeout = drawTimeout(s);
  x.timer = x.timeout;
}

function startElection(s: State, x: Server) {
  const prev = s.terms[x.term];
  if (x.role === "candidate" && prev && !prev.winner && !prev.failed) {
    prev.failed = true;
    if (prev.candidates.length > 1) {
      s.splitVotes++;
      addLog(s, `Split vote in term ${x.term}: ${prev.candidates.map(name).join(" and ")} each stood, nobody reached ${MAJORITY}.`, "bad");
    }
  }
  const waited = x.timeout;
  x.term += 1;
  x.role = "candidate";
  x.votedFor = x.id;
  x.votes = [x.id];
  x.leaderId = null;
  resetTimer(s, x);
  s.elections++;
  const t = (s.terms[x.term] ??= { candidates: [], winner: null, failed: false });
  t.candidates.push(x.id);
  addLog(s, `${name(x.id)} heard nothing for ${waited} ms, starts term ${x.term} and votes for itself.`, "info");
  for (const y of s.servers) if (y.id !== x.id) send(s, x.id, y.id, "vote-req", x.term);
}

function becomeLeader(s: State, x: Server) {
  x.role = "leader";
  x.leaderId = x.id;
  x.hb = 0;
  s.terms[x.term].winner = x.id;
  x.isolatedLeader = false;
  addLog(s, `${name(x.id)} wins term ${x.term} with ${x.votes.length} votes (${x.votes.map(name).join(", ")}).`, "ok");
  if (s.lostLeaderAt !== null && sideSize(s, x.id) >= MAJORITY) {
    s.failovers.push(s.now - s.lostLeaderAt);
    s.lostLeaderAt = null;
    s.flags.replaced = true;
  }
  const others = s.servers.filter((y) => y.alive && y.role === "leader" && y.id !== x.id);
  if (others.length) s.flags.twoLeaders = true;
}

function deliver(s: State, m: Msg) {
  const x = s.servers[m.to];
  if (!x.alive || !reachable(s, m.from, m.to)) return;
  if (m.term > x.term) becomeFollower(s, x, m.term);
  switch (m.kind) {
    case "vote-req": {
      const grant = m.term === x.term && (x.votedFor === null || x.votedFor === m.from);
      if (grant) {
        x.votedFor = m.from;
        resetTimer(s, x);
      }
      send(s, x.id, m.from, "vote", x.term, grant);
      break;
    }
    case "vote": {
      if (x.role !== "candidate" || m.term !== x.term || !m.granted) break;
      if (!x.votes.includes(m.from)) x.votes.push(m.from);
      if (x.votes.length >= MAJORITY) becomeLeader(s, x);
      break;
    }
    case "append": {
      if (m.term < x.term) { send(s, x.id, m.from, "append-reply", x.term); break; }
      if (x.role !== "follower") { x.role = "follower"; x.votes = []; }
      x.leaderId = m.from;
      resetTimer(s, x);
      send(s, x.id, m.from, "append-reply", x.term);
      break;
    }
    case "append-reply":
      break; // a higher term in the reply was handled above
  }
}

function tick1(s: State) {
  s.now += 1;
  // Deliver what has arrived, oldest first.
  const due = s.msgs.filter((m) => m.deliverAt <= s.now).sort((a, b) => a.deliverAt - b.deliverAt || a.id - b.id);
  s.msgs = s.msgs.filter((m) => m.deliverAt > s.now);
  for (const m of due) deliver(s, m);
  // Timers.
  for (const x of s.servers) {
    if (!x.alive) continue;
    if (x.role === "leader") {
      x.hb -= 1;
      if (x.hb <= 0) {
        x.hb = HEARTBEAT;
        for (const y of s.servers) if (y.id !== x.id) send(s, x.id, y.id, "append", x.term);
      }
      if (sideSize(s, x.id) < MAJORITY) x.isolatedLeader = true;
    } else {
      x.timer -= 1;
      if (x.timer <= 0) startElection(s, x);
    }
  }
  // Bookkeeping.
  const leader = usableLeader(s);
  if (leader) s.leaderlessRun = 0;
  else {
    s.leaderless += 1;
    s.leaderlessRun += 1;
    if (s.lostLeaderAt === null) s.lostLeaderAt = s.now;
    if (s.servers.filter((x) => x.alive).length < MAJORITY && s.leaderlessRun >= 1000) s.flags.noQuorum = true;
  }
  if (s.minorityStartTerm !== null) {
    const minority = s.servers.filter((x) => x.alive && sideSize(s, x.id) < MAJORITY);
    if (minority.some((x) => x.term >= (s.minorityStartTerm as number) + 3 && x.role !== "leader")) s.flags.minorityClimb = true;
  }
}

/* ---------------- step ---------------- */

const clone = (s: State): State => ({
  ...s,
  servers: s.servers.map((x) => ({ ...x, votes: [...x.votes] })),
  msgs: [...s.msgs],
  terms: Object.fromEntries(Object.entries(s.terms).map(([k, v]) => [k, { ...v, candidates: [...v.candidates] }])),
  failovers: [...s.failovers],
  flags: { ...s.flags },
  log: [...s.log],
});

export function step(prev: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return prev.prediction ? prev : { ...prev, prediction: a.value };
    case "tick": {
      const s = clone(prev);
      const ms = Math.max(0, Math.min(200, Math.round(a.ms)));
      for (let i = 0; i < ms; i++) tick1(s);
      return s;
    }
    case "kill": {
      const x0 = prev.servers[a.id];
      if (!x0 || !x0.alive) return prev;
      const s = clone(prev);
      const x = s.servers[a.id];
      const wasUsable = usableLeader(s)?.id === x.id;
      x.alive = false;
      s.msgs = s.msgs.filter((m) => m.from !== x.id && m.to !== x.id);
      addLog(s, `${name(x.id)} crashed${x.role === "leader" ? " while leading term " + x.term : ""}. Its heartbeats stop.`, "bad");
      if (wasUsable) s.lostLeaderAt = s.now;
      return s;
    }
    case "revive": {
      const x0 = prev.servers[a.id];
      if (!x0 || x0.alive) return prev;
      const s = clone(prev);
      const x = s.servers[a.id];
      // Term and vote are on disk; everything else starts over, as a follower.
      x.alive = true;
      x.role = "follower";
      x.votes = [];
      x.leaderId = null;
      x.isolatedLeader = false;
      resetTimer(s, x);
      addLog(s, `${name(x.id)} restarts as a follower, remembering term ${x.term} from disk.`, "info");
      return s;
    }
    case "partition": {
      const s = clone(prev);
      s.partition = a.kind;
      for (const x of s.servers) x.side = 0;
      if (a.kind !== "none") {
        const lead = usableLeader(s) ?? s.servers.find((x) => x.alive && x.role === "leader") ?? s.servers[0];
        // Two servers go to side 1: the leader and one other, or two others.
        const others = s.servers.filter((x) => x.id !== lead.id);
        const cut = a.kind === "leader-in-minority" ? [lead, others[0]] : [others[others.length - 2], others[others.length - 1]];
        for (const x of cut) x.side = 1;
        s.minorityStartTerm = Math.max(...cut.map((x) => x.term));
        addLog(s, `Network split: ${cut.map((x) => name(x.id)).join(", ")} | ${s.servers.filter((x) => x.side === 0).map((x) => name(x.id)).join(", ")}. Messages across the cut are lost.`, "bad");
      } else {
        s.minorityStartTerm = null;
        addLog(s, "The network heals. Every server can reach every other again.", "info");
      }
      s.msgs = s.msgs.filter((m) => reachable(s, m.from, m.to));
      return s;
    }
    case "setMode": {
      const s = clone(prev);
      s.mode = a.mode;
      return s;
    }
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "replaced", text: "Kill the leader and watch another server take over." },
  { id: "split", text: "Set the timeouts to 150 ms with no randomness, then kill the leader. Watch for split votes." },
  { id: "minorityClimb", text: "Split the network with the leader on the 3 side. Watch the 2 side's terms climb with no leader." },
  { id: "deposed", text: "Split it with the leader on the 2 side, let the 3 side elect, then heal and watch the old leader step down." },
  { id: "noQuorum", text: "Kill three servers. Can the two left elect a leader?" },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  switch (id) {
    case "replaced": return s.flags.replaced;
    case "split": return s.splitVotes > 0;
    case "minorityClimb": return s.flags.minorityClimb;
    case "deposed": return s.flags.deposed;
    case "noQuorum": return s.flags.noQuorum;
  }
}

export const maxTerm = (s: State) => Math.max(...s.servers.map((x) => x.term));
