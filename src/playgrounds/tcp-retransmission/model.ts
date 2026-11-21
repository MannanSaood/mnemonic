// TCP retransmission playground: a sender streams 20 segments over a path whose round trip the
// reader controls. Every ACK that measures a clean round trip updates SRTT, RTTVAR and RTO by the
// RFC 6298 formulas, shown with the reader's own numbers. The reader loses segments (once, or
// twice to force a backoff), delays one past the timer, toggles SACK and picks the RTO floor.
//
// After this, the reader can answer: "When TCP loses a segment, what tells it to resend: three
// duplicate ACKs or its timer, and why does one cost a round trip while the other costs at least
// 200 ms and doubles on every repeat?"
// Core insight: the retransmission timeout is learned from measured round trips (SRTT plus four
// times their variation, never below a floor). Most losses are found faster than that, by
// duplicate ACKs from the segments that came after. A loss with nothing after it, or a lost
// retransmission, must wait for the timer, and each repeat doubles it.
//
// Deliberate simplifications: the window is fixed (no congestion control, that is a later lesson),
// the receiver ACKs every segment at once (no delayed ACK), and the Linux floor is applied as
// max(200 ms, RTO) rather than Linux's exact variance arithmetic.
//
// Plain state + a pure step function. simulate() is deterministic, so every scenario is testable.

export type Fault = "ok" | "drop" | "drop2" | "late";
export type Jitter = "none" | "some" | "wild";
export type Floor = "linux" | "rfc";

export const N = 20;
export const WINDOW = 6;
export const TX = 4; // ms to put one segment on the wire
export const INITIAL_RTO = 1000; // RFC 6298 (2.1)
export const MAX_RTO = 60_000; // RFC 6298 (2.5) allows a cap of at least 60 s
export const G = 1; // clock granularity, ms
export const FLOOR_MS: Record<Floor, number> = { linux: 200, rfc: 1000 };
export const DUP_THRESH = 3; // RFC 5681
export const FAULTS: Fault[] = ["ok", "drop", "drop2", "late"];
export const FAULT_LABEL: Record<Fault, string> = {
  ok: "Delivered",
  drop: "Lost once",
  drop2: "Lost, and its resend lost too",
  late: "Delayed by 4 round trips",
};
const LIMIT = 40_000;

export interface Config { baseRtt: number; jitter: Jitter; floor: Floor; sack: boolean; faults: Fault[] }

export interface Packet {
  id: number;
  kind: "data" | "ack";
  /** Data: segment number (1..N). ACK: the next segment expected (cumulative). */
  seq: number;
  sack: number[];
  sendT: number;
  arriveT: number | null;
  retrans: boolean;
  /** For an ACK: how many times in a row this ACK number has been sent without progress. */
  dup: number;
  /** For an ACK: the data packet whose arrival produced it. */
  trigger?: number;
  /** Data that arrived but the receiver already had. */
  needless?: boolean;
  late?: boolean;
}

export type Ev =
  | { kind: "sample"; t: number; seg: number; r: number; srtt: number; rttvar: number; rto: number; prevSrtt: number | null; prevRttvar: number | null; floored: boolean }
  | { kind: "karn"; t: number; seg: number }
  | { kind: "timeout"; t: number; seg: number; oldRto: number; rto: number }
  | { kind: "fast"; t: number; seg: number }
  | { kind: "sackResend"; t: number; seg: number }
  | { kind: "partial"; t: number; seg: number };

export interface Result {
  packets: Packet[];
  events: Ev[];
  doneAt: number;
  end: number;
  complete: boolean;
  retransmissions: number;
  fast: number;
  timeouts: number;
  /** Retransmissions of segments the receiver already had. */
  needless: number;
  finalRto: number;
  finalSrtt: number | null;
}

/** Deterministic 0..1 noise per packet, so a run replays exactly. */
function noise(id: number): number {
  let x = (id * 2654435761 + 1013904223) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function oneWay(cfg: Config, id: number): number {
  const half = cfg.baseRtt / 2;
  const amp = cfg.jitter === "none" ? 0 : cfg.jitter === "some" ? 0.25 : 0.6;
  return Math.max(1, Math.round(half * (1 + amp * (noise(id) * 2 - 1))));
}

export function simulate(cfg: Config): Result {
  const floor = FLOOR_MS[cfg.floor];
  const packets: Packet[] = [];
  const events: Ev[] = [];
  let pid = 0;

  // sender
  let base = 1, nextSeq = 1, linkFree = 0;
  let srtt: number | null = null, rttvar = 0, rto = INITIAL_RTO;
  let timerAt: number | null = null;
  let lastAck = 1, dupCount = 0;
  let inRecovery = false, recover = -1;
  const sacked = new Set<number>();
  const sendCount = new Array<number>(N + 2).fill(0);
  const resentInRecovery = new Set<number>();
  let queue: number[] = [];
  let doneAt = -1;

  // receiver
  let expected = 1;
  const got = new Set<number>();
  let lastAckSent = 0, ackDup = 0;

  const inflight: Packet[] = [];
  // the path keeps packets in order (queues are FIFO); only a "late" packet overtakes nothing
  let lastDataArrive = 0, lastAckArrive = 0;

  const sendData = (t: number, seq: number) => {
    const n = sendCount[seq]++;
    const f = cfg.faults[seq - 1] ?? "ok";
    const lost = (f === "drop" && n === 0) || (f === "drop2" && n <= 1);
    const id = pid++;
    const late = f === "late" && n === 0;
    const delay = oneWay(cfg, id) + TX + (late ? cfg.baseRtt * 4 : 0);
    let arrive = t + delay;
    if (!late && !lost) { arrive = Math.max(arrive, lastDataArrive + 1); lastDataArrive = arrive; }
    const p: Packet = { id, kind: "data", seq, sack: [], sendT: t, arriveT: lost ? null : arrive, retrans: n > 0, dup: 0, late };
    packets.push(p);
    if (!lost) inflight.push(p);
    linkFree = t + TX;
    if (timerAt === null) timerAt = t + rto; // RFC 6298 (5.1)
  };

  const sendAck = (t: number, trigger: Packet) => {
    if (expected === lastAckSent) ackDup++;
    else { ackDup = 0; lastAckSent = expected; }
    const sack = cfg.sack ? [...got].filter((s) => s > expected).sort((a, b) => a - b) : [];
    const id = pid++;
    const arrive = Math.max(t + oneWay(cfg, id + 7919), lastAckArrive);
    lastAckArrive = arrive;
    const p: Packet = { id, kind: "ack", seq: expected, sack, sendT: t, arriveT: arrive, retrans: false, dup: ackDup, trigger: trigger.id };
    packets.push(p);
    inflight.push(p);
  };

  const onSample = (t: number, seg: number, r: number) => {
    const prevSrtt = srtt, prevRttvar = srtt === null ? null : rttvar;
    if (srtt === null) { srtt = r; rttvar = r / 2; } // (2.2)
    else { rttvar = 0.75 * rttvar + 0.25 * Math.abs(srtt - r); srtt = 0.875 * srtt + 0.125 * r; } // (2.3)
    const raw = srtt + Math.max(G, 4 * rttvar);
    rto = Math.min(MAX_RTO, Math.max(floor, raw)); // (2.4), (2.5)
    events.push({ kind: "sample", t, seg, r, srtt, rttvar, rto, prevSrtt, prevRttvar, floored: raw < floor });
  };

  const holes = () => {
    const top = Math.max(0, ...sacked);
    const out: number[] = [];
    for (let s = base; s < top; s++) if (!sacked.has(s) && !resentInRecovery.has(s)) out.push(s);
    return out;
  };

  let t = 0;
  for (; t <= LIMIT; t++) {
    const now = inflight.filter((p) => p.arriveT === t).sort((a, b) => a.id - b.id);
    for (const p of now) {
      inflight.splice(inflight.indexOf(p), 1);
      if (p.kind === "data") {
        if (got.has(p.seq) || p.seq < expected) p.needless = true;
        got.add(p.seq);
        while (got.has(expected)) expected++;
        sendAck(t, p); // RFC 5681 4.2: out-of-order data is ACKed at once
        continue;
      }
      // ---- ACK at the sender
      for (const s of p.sack) sacked.add(s);
      const a = p.seq;
      if (a > base) {
        // new data acknowledged
        // Karn: a segment sent more than once gives an ambiguous sample, so skip it
        const trig = packets[p.trigger!];
        if (trig && sendCount[trig.seq] === 1) onSample(t, trig.seq, t - trig.sendT);
        else if (trig) events.push({ kind: "karn", t, seg: trig.seq });
        base = a;
        for (const s of [...sacked]) if (s < base) sacked.delete(s);
        queue = queue.filter((s) => s >= base);
        dupCount = 0;
        lastAck = a;
        if (inRecovery) {
          if (a > recover) { inRecovery = false; resentInRecovery.clear(); }
          else if (!cfg.sack) {
            // NewReno: a partial ACK points at the next hole
            events.push({ kind: "partial", t, seg: a });
            if (!queue.includes(a)) queue.unshift(a);
            resentInRecovery.add(a);
          }
        }
        timerAt = base > N ? null : t + rto; // (5.2), (5.3)
      } else if (a === lastAck && base <= N) {
        dupCount++;
        // RFC 6582: only a loss after the last recovery point starts a new fast retransmit
        if (dupCount === DUP_THRESH && !inRecovery && base > recover + 1) {
          inRecovery = true;
          recover = nextSeq - 1;
          events.push({ kind: "fast", t, seg: base });
          queue = [base, ...queue.filter((s) => s !== base)];
          resentInRecovery.add(base);
        }
      }
      if (inRecovery && cfg.sack) {
        for (const h of holes()) {
          if (!queue.includes(h)) {
            queue.push(h);
            events.push({ kind: "sackResend", t, seg: h });
          }
          resentInRecovery.add(h);
        }
      }
    }
    if (base > N && doneAt < 0) { doneAt = t; timerAt = null; }

    // retransmission timer (5.4 - 5.6)
    if (timerAt !== null && t >= timerAt) {
      const oldRto = rto;
      rto = Math.min(MAX_RTO, rto * 2);
      events.push({ kind: "timeout", t, seg: base, oldRto, rto });
      inRecovery = false;
      resentInRecovery.clear();
      dupCount = 0;
      recover = nextSeq - 1;
      // after a timeout, treat everything outstanding as lost and send it again from the oldest,
      // skipping what SACK says arrived (as Linux does); without SACK that includes segments
      // the receiver already holds
      queue = [];
      for (let x = base; x < nextSeq; x++) if (!sacked.has(x)) queue.push(x);
      timerAt = t + rto;
    }

    // the link: one segment at a time, resends first
    if (t >= linkFree && doneAt < 0) {
      while (queue.length && queue[0] < base) queue.shift();
      if (queue.length) {
        const s = queue.shift()!;
        sendData(t, s);
      } else if (nextSeq <= N && nextSeq < base + WINDOW) {
        sendData(t, nextSeq);
        nextSeq++;
      }
    }
    if (doneAt >= 0 && inflight.length === 0) break;
  }

  const data = packets.filter((p) => p.kind === "data");
  const finish = doneAt >= 0 ? doneAt : t;
  return {
    packets,
    events,
    doneAt: finish,
    end: Math.max(finish, ...packets.map((p) => p.arriveT ?? p.sendT)),
    complete: doneAt >= 0,
    retransmissions: data.filter((p) => p.retrans).length,
    fast: events.filter((e) => e.kind === "fast").length,
    timeouts: events.filter((e) => e.kind === "timeout").length,
    needless: data.filter((p) => p.retrans && p.needless).length + data.filter((p) => !p.retrans && p.needless).length,
    finalRto: rto,
    finalSrtt: srtt,
  };
}

/** The sender's estimator at time t: the last sample or backoff at or before t. */
export function estimatorAt(r: Result, t: number): { srtt: number | null; rttvar: number | null; rto: number; last: Ev | null } {
  let srtt: number | null = null, rttvar: number | null = null, rto = INITIAL_RTO, last: Ev | null = null;
  for (const e of r.events) {
    if (e.t > t) break;
    if (e.kind === "sample") { srtt = e.srtt; rttvar = e.rttvar; rto = e.rto; last = e; }
    else if (e.kind === "timeout") { rto = e.rto; last = e; }
    else if (e.kind === "karn") last = e;
  }
  return { srtt, rttvar, rto, last };
}

/** Duplicate ACKs the sender has seen in a row at time t. */
export function dupAcksAt(r: Result, t: number): number {
  const acks = r.packets.filter((p) => p.kind === "ack" && p.arriveT !== null && p.arriveT <= t).sort((a, b) => a.arriveT! - b.arriveT! || a.id - b.id);
  let last = -1, dups = 0;
  for (const a of acks) {
    if (a.seq === last) dups++;
    else if (a.seq > last) { last = a.seq; dups = 0; }
  }
  return dups;
}

/* ---------------- playground state ---------------- */

export type ChallengeId = "fast" | "tail" | "backoff" | "spurious";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "fast", text: "Lose one segment in the middle and get it resent with no timeout." },
  { id: "tail", text: "Lose segment 20, the last one. What has to resend it now?" },
  { id: "backoff", text: "Make the RTO double: lose a segment and its resend." },
  { id: "spurious", text: "Make TCP resend a segment that was never lost." },
];

export interface State {
  baseRtt: number;
  jitter: Jitter;
  floor: Floor;
  sack: boolean;
  faults: Fault[];
  t: number;
  prediction: string | null;
  revealed: boolean;
  done: ChallengeId[];
}

export type Action =
  | { type: "rtt"; ms: number }
  | { type: "jitter"; value: Jitter }
  | { type: "floor"; value: Floor }
  | { type: "sack"; on: boolean }
  | { type: "cycleFault"; seq: number }
  | { type: "setFault"; seq: number; fault: Fault }
  | { type: "clear" }
  | { type: "tick"; ms: number }
  | { type: "toEnd" }
  | { type: "rewind" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export const clean = (): Fault[] => new Array<Fault>(N).fill("ok");

export function init(): State {
  return { baseRtt: 60, jitter: "some", floor: "linux", sack: true, faults: clean(), t: 0, prediction: null, revealed: false, done: [] };
}

export const configOf = (s: State): Config => ({ baseRtt: s.baseRtt, jitter: s.jitter, floor: s.floor, sack: s.sack, faults: s.faults });

function finish(s: State): State {
  const r = simulate(configOf(s));
  const done = new Set(s.done);
  if (r.fast > 0 && r.timeouts === 0 && r.retransmissions > 0) done.add("fast");
  if (s.faults[N - 1] !== "ok" && r.events.some((e) => e.kind === "timeout" && e.seg === N)) done.add("tail");
  if (s.faults.includes("drop2") && r.timeouts > 0) done.add("backoff");
  if (r.needless > 0 && !s.faults.some((f) => f === "drop" || f === "drop2")) done.add("spurious");
  return {
    ...s,
    t: r.end,
    revealed: s.revealed || (r.fast > 0),
    done: CHALLENGES.map((c) => c.id).filter((id) => done.has(id)),
  };
}

const rewound = (s: State, patch: Partial<State>): State => ({ ...s, ...patch, t: 0 });

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "rtt":
      return rewound(s, { baseRtt: Math.min(200, Math.max(20, Math.round(a.ms))) });
    case "jitter":
      return rewound(s, { jitter: a.value });
    case "floor":
      return rewound(s, { floor: a.value });
    case "sack":
      return rewound(s, { sack: a.on });
    case "clear":
      return rewound(s, { faults: clean() });
    case "cycleFault": {
      const f = [...s.faults];
      f[a.seq - 1] = FAULTS[(FAULTS.indexOf(f[a.seq - 1]) + 1) % FAULTS.length];
      return rewound(s, { faults: f });
    }
    case "setFault": {
      const f = [...s.faults];
      f[a.seq - 1] = a.fault;
      return rewound(s, { faults: f });
    }
    case "rewind":
      return { ...s, t: 0 };
    case "toEnd":
      return finish(s);
    case "tick": {
      const end = simulate(configOf(s)).end;
      if (s.t >= end) return s;
      const t = s.t + a.ms;
      return t >= end ? finish(s) : { ...s, t };
    }
  }
}
