// Zombie leader playground: a lock service with leases, two workers and a storage service.
//
// After this, the reader can answer: why can a worker that holds a lease still write after its
// lease has expired and someone else holds it (a process pause between the check and the write),
// and why must the storage service, not the worker or the lock service, reject the stale write
// by comparing fencing tokens?
//
// The model follows Kleppmann's "How to do distributed locking" (2016): the lock service grants a
// lease with a token that rises on every grant (33, then 34); the holder renews it while it runs;
// a stop-the-world pause freezes the holder with a rendered, already checked write in hand. Every
// write goes to two storage services side by side: one accepts anything, the other remembers the
// highest token it has seen and rejects lower ones. Time is in ms and moves in fixed ticks.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const WORKERS = ["A", "B"] as const;
export type WId = 0 | 1;

export const TICK = 250;
export const TTL = 10_000;
export const RENEW = 3_000;
export const WRITE_EVERY = 2_000;
export const POLL = 1_000;
export const FIRST_TOKEN = 33;
export const PAUSES = [5_000, 15_000, 30_000] as const;
export type PauseLen = (typeof PAUSES)[number];

export type Role = "leader" | "standby";
export type SegKind = "leader" | "paused" | "standby";

export interface Write { id: number; by: WId; token: number; batch: number; madeAt: number; at: number; leaseSeenUntil: number }
export interface StoreRec { write: number; accepted: boolean; stale: boolean }
export interface Store { highest: number; value: number | null; log: StoreRec[] }

export interface Worker {
  role: Role;
  token: number | null;
  /** When the worker last heard its lease was valid until. */
  leaseSeenUntil: number;
  pausedUntil: number | null;
  pending: Write | null;
  nextRenew: number;
  nextWrite: number;
  nextPoll: number;
}

export interface Seg { who: WId; kind: SegKind; from: number; to: number | null }
export interface Hold { holder: WId; token: number; from: number; to: number | null }
export interface Mark { t: number; who: WId | null; text: string; bad?: boolean }

export type Challenge = "short" | "stale" | "second";
export type Guess = "rejected" | "overwrites" | "notices";

export interface State {
  now: number;
  lock: { holder: WId | null; token: number; expires: number };
  workers: [Worker, Worker];
  writes: Write[];
  plain: Store;
  fenced: Store;
  segs: Seg[];
  holds: Hold[];
  marks: Mark[];
  pauseLen: PauseLen;
  batch: number;
  /** ms during which both workers believed they were the leader. */
  overlap: number;
  pauses: number;
  done: Challenge[];
  prediction: Guess | null;
}

export type Action =
  | { type: "tick"; ms: number }
  | { type: "pause"; who: WId }
  | { type: "setPause"; ms: PauseLen }
  | { type: "predict"; value: Guess }
  | { type: "reset" };

const store = (): Store => ({ highest: 0, value: null, log: [] });

export function init(): State {
  return {
    now: 0,
    lock: { holder: 0, token: FIRST_TOKEN, expires: TTL },
    workers: [
      { role: "leader", token: FIRST_TOKEN, leaseSeenUntil: TTL, pausedUntil: null, pending: null, nextRenew: RENEW, nextWrite: 1_000, nextPoll: 0 },
      { role: "standby", token: null, leaseSeenUntil: 0, pausedUntil: null, pending: null, nextRenew: 0, nextWrite: 0, nextPoll: 500 },
    ],
    writes: [], plain: store(), fenced: store(),
    segs: [{ who: 0, kind: "leader", from: 0, to: null }, { who: 1, kind: "standby", from: 0, to: null }],
    holds: [{ holder: 0, token: FIRST_TOKEN, from: 0, to: null }],
    marks: [{ t: 0, who: 0, text: `A holds the lease with token ${FIRST_TOKEN}, valid for ${TTL / 1000} s, and renews it every ${RENEW / 1000} s.` }],
    pauseLen: 15_000, batch: 0, overlap: 0, pauses: 0, done: [], prediction: null,
  };
}

export const secs = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : ms % 500 === 0 ? 1 : 2)} s`;

// ---- mutable helpers on a fresh copy (the step function copies state first) ----

function setSeg(s: State, who: WId, kind: SegKind) {
  const open = s.segs.find((g) => g.who === who && g.to === null);
  if (open && open.kind === kind) return;
  if (open) open.to = s.now;
  s.segs.push({ who, kind, from: s.now, to: null });
}

function mark(s: State, who: WId | null, text: string, bad = false) {
  s.marks.push({ t: s.now, who, text, bad });
}

function deliver(s: State, w: Write) {
  s.writes.push(w);
  const staleP = w.token < s.plain.highest;
  s.plain.log.push({ write: w.id, accepted: true, stale: staleP });
  s.plain.highest = Math.max(s.plain.highest, w.token);
  s.plain.value = w.id;
  const ok = w.token >= s.fenced.highest;
  s.fenced.log.push({ write: w.id, accepted: ok, stale: !ok });
  if (ok) { s.fenced.highest = w.token; s.fenced.value = w.id; }
  if (staleP) {
    mark(s, w.by, `${WORKERS[w.by]}'s write with token ${w.token} reaches storage. Plain storage accepts it over newer data (token ${s.plain.highest}). Fenced storage rejects it: ${w.token} < ${s.fenced.highest}.`, true);
  }
}

function makeWrite(s: State, who: WId): Write {
  const W = s.workers[who];
  s.batch++;
  return { id: s.batch, by: who, token: W.token!, batch: s.batch, madeAt: s.now, at: s.now, leaseSeenUntil: W.leaseSeenUntil };
}

function clone(st: State): State {
  return {
    ...st,
    lock: { ...st.lock },
    workers: [{ ...st.workers[0] }, { ...st.workers[1] }],
    writes: [...st.writes],
    plain: { ...st.plain, log: [...st.plain.log] },
    fenced: { ...st.fenced, log: [...st.fenced.log] },
    segs: st.segs.map((g) => ({ ...g })),
    holds: st.holds.map((h) => ({ ...h })),
    marks: [...st.marks],
    done: [...st.done],
  };
}

function once(s: State) {
  s.now += TICK;
  const L = s.lock;
  if (L.holder !== null && s.now >= L.expires) {
    mark(s, L.holder, `The lease of ${WORKERS[L.holder]} (token ${L.token}) expires: no renewal for ${TTL / 1000} s.`);
    const h = s.holds.find((x) => x.to === null);
    if (h) h.to = s.now;
    L.holder = null;
  }
  for (const who of [0, 1] as WId[]) {
    const W = s.workers[who];
    if (W.pausedUntil !== null) {
      if (s.now < W.pausedUntil) continue;
      W.pausedUntil = null;
      const stillMine = L.holder === who && L.token === W.token;
      if (stillMine && !s.done.includes("short")) s.done.push("short");
      mark(s, who, stillMine
        ? `${WORKERS[who]} wakes up. Its lease is still valid, so the pause did no harm.`
        : `${WORKERS[who]} wakes up and carries on, still sure it holds the lease (it checked: valid until ${secs(W.leaseSeenUntil)}).`, !stillMine);
      setSeg(s, who, W.role);
      if (W.pending) { deliver(s, { ...W.pending, at: s.now }); W.pending = null; W.nextWrite = s.now + WRITE_EVERY; }
      W.nextRenew = Math.min(W.nextRenew, s.now);
    }
    if (W.role === "leader") {
      if (s.now >= W.nextRenew) {
        if (L.holder === who && L.token === W.token) {
          L.expires = s.now + TTL;
          W.leaseSeenUntil = L.expires;
          W.nextRenew = s.now + RENEW;
        } else {
          mark(s, who, `${WORKERS[who]} tries to renew and learns token ${W.token} is gone${L.holder !== null ? `: ${WORKERS[L.holder]} holds ${L.token}` : ""}. It steps down.`);
          W.role = "standby"; W.token = null; W.nextPoll = s.now + POLL;
          setSeg(s, who, "standby");
        }
      }
      if (W.role === "leader" && s.now >= W.nextWrite) {
        deliver(s, makeWrite(s, who));
        W.nextWrite = s.now + WRITE_EVERY;
      }
    } else if (s.now >= W.nextPoll) {
      if (L.holder === null) {
        L.token++; L.holder = who; L.expires = s.now + TTL;
        W.role = "leader"; W.token = L.token; W.leaseSeenUntil = L.expires;
        W.nextRenew = s.now + RENEW; W.nextWrite = s.now + 1_000;
        s.holds.push({ holder: who, token: L.token, from: s.now, to: null });
        setSeg(s, who, "leader");
        mark(s, who, `The lease is free. ${WORKERS[who]} acquires it with token ${L.token}.`);
        if (L.token >= FIRST_TOKEN + 2 && !s.done.includes("second")) s.done.push("second");
      }
      W.nextPoll = s.now + POLL;
    }
  }
  if (s.workers[0].role === "leader" && s.workers[1].role === "leader") s.overlap += TICK;
  if (s.plain.log.some((r) => r.stale) && !s.done.includes("stale")) s.done.push("stale");
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return { ...st, prediction: a.value };
    case "setPause":
      return { ...st, pauseLen: a.ms };
    case "pause": {
      const W = st.workers[a.who];
      if (W.role !== "leader" || W.pausedUntil !== null) return st;
      const s = clone(st);
      const w = s.workers[a.who];
      w.pending = makeWrite(s, a.who);
      w.pausedUntil = s.now + s.pauseLen;
      s.pauses++;
      setSeg(s, a.who, "paused");
      mark(s, a.who, `${WORKERS[a.who]} checks its lease (valid until ${secs(w.leaseSeenUntil)}), renders batch ${w.pending.batch}, and freezes in a ${secs(s.pauseLen)} GC pause just before sending it.`);
      return s;
    }
    case "tick": {
      const s = clone(st);
      for (let t = 0; t < a.ms; t += TICK) once(s);
      s.done = (["short", "stale", "second"] as Challenge[]).filter((c) => s.done.includes(c));
      return s;
    }
  }
}

export const writeById = (st: State, id: number) => st.writes.find((w) => w.id === id)!;
export const believesLeader = (st: State, who: WId) => st.workers[who].role === "leader";
export const staleAccepted = (st: State) => st.plain.log.filter((r) => r.stale).length;
export const staleRejected = (st: State) => st.fenced.log.filter((r) => !r.accepted).length;
