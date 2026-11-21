// Reliable-transfer playground: a sender ships 10 numbered messages to a receiver over a link that
// the reader can break, packet by packet. The reader picks stop-and-wait, go-back-N or selective
// repeat, sets the window, and watches the sequence diagram fill in over time.
//
// After this, the reader can answer: "Numbers, ACKs and a timer make a lossy link reliable; what
// does keeping many packets in flight buy, and what does each design resend when one is lost?"
// Core insight: stop-and-wait is reliable but leaves the link idle for a whole round trip per
// message. A window keeps the link busy. When a packet is lost, go-back-N resends everything after
// it; selective repeat resends only the gap. Sequence numbers are what stop a retry becoming a
// duplicate.
//
// Plain state + a pure step function. simulate() is a deterministic discrete-time simulation, so
// the same fault plan can be replayed on every protocol and tested without a browser.

export type Protocol = "sw" | "gbn" | "sr";
export type Fault = "ok" | "drop" | "delay" | "dup" | "ackdrop";

export const PROTOCOLS: Protocol[] = ["sw", "gbn", "sr"];
export const PROTOCOL_NAME: Record<Protocol, string> = { sw: "Stop-and-wait", gbn: "Go-back-N", sr: "Selective repeat" };
export const FAULTS: Fault[] = ["ok", "drop", "delay", "dup", "ackdrop"];
export const FAULT_LABEL: Record<Fault, string> = {
  ok: "Delivered",
  drop: "Packet lost",
  delay: "Packet delayed 40 ms",
  dup: "Packet copied",
  ackdrop: "ACK lost",
};

/** 10 messages, 2 ms to put a packet on the wire, 10 ms each way, retransmit timer 30 ms. */
export const N = 10;
export const TX = 2;
export const PROP = 10;
export const TIMEOUT = 30;
export const EXTRA_DELAY = 40;
export const DUP_GAP = 3;
export const RTT = TX + 2 * PROP;
const LIMIT = 3000;

export interface Config { protocol: Protocol; window: number; faults: Fault[]; seqCheck: boolean }

export interface Packet {
  id: number;
  kind: "data" | "ack";
  /** Data: the sequence number. ACK: the number acknowledged (-1 = nothing yet). */
  seq: number;
  sendT: number;
  /** When it reaches the other side, or null when the network drops it. */
  arriveT: number | null;
  retrans: boolean;
  /** A copy made by the network. */
  copy: boolean;
  /** What the receiver did with a data packet (filled in on arrival). */
  outcome?: "delivered" | "buffered" | "discarded" | "duplicate";
  /** An ACK the sender already had (a duplicate ACK). */
  dupAck?: boolean;
  faulted?: Fault;
}

export interface Delivery { t: number; seq: number; dup: boolean; outOfOrder: boolean }

export interface Result {
  packets: Packet[];
  timeouts: { t: number; seq: number }[];
  deliveries: Delivery[];
  /** When the sender had every message acknowledged. */
  doneAt: number;
  /** When the last packet (including stragglers) landed. */
  end: number;
  dataSent: number;
  retransmissions: number;
  dupDelivered: number;
  outOfOrder: number;
  /** Messages the app never received. */
  missing: number;
  maxBuffered: number;
  /** Share of time the sender's link carried useful (first-copy) data. */
  utilisation: number;
  complete: boolean;
  /** When the sender first counted each message as acknowledged (-1: never). */
  ackedAt: number[];
}

interface Timer { seq: number; at: number }

/** Run the whole transfer for one configuration. Deterministic. */
export function simulate(cfg: Config): Result {
  const W = cfg.protocol === "sw" ? 1 : Math.max(1, cfg.window);
  const packets: Packet[] = [];
  const timeouts: Result["timeouts"] = [];
  const deliveries: Delivery[] = [];
  let pid = 0;

  // sender
  let base = 0, nextSeq = 0, linkFree = 0;
  const acked = new Array<boolean>(N).fill(false);
  const ackedAt = new Array<number>(N).fill(-1);
  const sentOnce = new Array<boolean>(N).fill(false);
  let resend: number[] = [];
  let timers: Timer[] = []; // gbn: at most one (for base); sw/sr: one per outstanding seq
  let lastAckNum = -2;
  let doneAt = -1;

  // receiver
  let expected = 0; // gbn: next in-order seq; sr/sw: receive base
  const buffered = new Set<number>();
  const deliveredSeqs = new Set<number>();
  let maxBuffered = 0;
  const firstArrivalSeen = new Array<boolean>(N).fill(false);
  let maxDelivered = -1;

  const inflight: Packet[] = []; // packets with an arrival time not yet processed

  const sendAck = (t: number, ackNum: number, fromFirstArrivalOf: number | null) => {
    const drop = fromFirstArrivalOf !== null && cfg.faults[fromFirstArrivalOf] === "ackdrop";
    const p: Packet = { id: pid++, kind: "ack", seq: ackNum, sendT: t, arriveT: drop ? null : t + PROP, retrans: false, copy: false, faulted: drop ? "ackdrop" : undefined };
    packets.push(p);
    if (!drop) inflight.push(p);
  };

  const deliverToApp = (t: number, seq: number) => {
    const dup = deliveredSeqs.has(seq);
    const outOfOrder = !dup && seq !== maxDelivered + 1;
    deliveries.push({ t, seq, dup, outOfOrder });
    deliveredSeqs.add(seq);
    if (!dup) maxDelivered = Math.max(maxDelivered, seq);
  };

  const receiveData = (t: number, p: Packet) => {
    const seq = p.seq;
    const first = !p.retrans && !p.copy && !firstArrivalSeen[seq];
    if (!p.retrans && !p.copy) firstArrivalSeen[seq] = true;
    const ackFault = first ? seq : null;
    if (!cfg.seqCheck) {
      // The receiver cannot tell old from new: everything goes to the app.
      deliverToApp(t, seq);
      p.outcome = "delivered";
      sendAck(t, seq, ackFault);
      return;
    }
    if (cfg.protocol === "gbn") {
      if (seq === expected) {
        deliverToApp(t, seq);
        p.outcome = "delivered";
        expected++;
      } else {
        p.outcome = seq < expected ? "duplicate" : "discarded";
      }
      sendAck(t, expected - 1, ackFault);
      return;
    }
    // sw and sr: accept anything inside the receive window, re-ACK anything older
    if (seq >= expected && seq < expected + W) {
      if (buffered.has(seq)) p.outcome = "duplicate";
      else {
        buffered.add(seq);
        p.outcome = seq === expected ? "delivered" : "buffered";
      }
      maxBuffered = Math.max(maxBuffered, [...buffered].filter((s) => s !== expected).length);
      while (buffered.has(expected)) {
        buffered.delete(expected);
        deliverToApp(t, expected);
        expected++;
      }
    } else {
      p.outcome = "duplicate";
    }
    sendAck(t, seq, ackFault);
  };

  const transmit = (t: number, seq: number) => {
    const retrans = sentOnce[seq];
    sentOnce[seq] = true;
    const fault: Fault = retrans ? "ok" : cfg.faults[seq] ?? "ok";
    const arrive = t + TX + PROP + (fault === "delay" ? EXTRA_DELAY : 0);
    const p: Packet = { id: pid++, kind: "data", seq, sendT: t, arriveT: fault === "drop" ? null : arrive, retrans, copy: false, faulted: fault === "ok" ? undefined : fault };
    packets.push(p);
    if (p.arriveT !== null) inflight.push(p);
    if (fault === "dup") {
      const c: Packet = { id: pid++, kind: "data", seq, sendT: t, arriveT: arrive + DUP_GAP, retrans, copy: true, faulted: "dup" };
      packets.push(c);
      inflight.push(c);
    }
    linkFree = t + TX;
    if (cfg.protocol === "gbn") {
      if (!timers.length) timers = [{ seq: base, at: t + TIMEOUT }];
    } else {
      timers = timers.filter((x) => x.seq !== seq).concat({ seq, at: t + TIMEOUT });
    }
  };

  let t = 0;
  for (; t <= LIMIT; t++) {
    // 1. arrivals at either end, in arrival order
    const now = inflight.filter((p) => p.arriveT === t).sort((a, b) => a.id - b.id);
    for (const p of now) {
      inflight.splice(inflight.indexOf(p), 1);
      if (p.kind === "data") receiveData(t, p);
      else {
        const a = p.seq;
        if (cfg.protocol === "gbn") {
          p.dupAck = a < base || a === lastAckNum;
          if (a >= base) {
            for (let s = base; s <= a; s++) { acked[s] = true; ackedAt[s] = t; }
            base = a + 1;
            resend = resend.filter((s) => s >= base);
            timers = base === nextSeq ? [] : [{ seq: base, at: t + TIMEOUT }];
          }
          lastAckNum = Math.max(lastAckNum, a);
        } else {
          if (a < 0 || a >= N) continue;
          p.dupAck = acked[a];
          if (!acked[a]) ackedAt[a] = t;
          acked[a] = true;
          timers = timers.filter((x) => x.seq !== a);
          resend = resend.filter((s) => s !== a);
          while (base < N && acked[base]) base++;
        }
      }
    }
    if (base >= N && doneAt < 0) doneAt = t;

    // 2. timers
    const fired = timers.filter((x) => x.at === t);
    for (const f of fired) {
      timeouts.push({ t, seq: f.seq });
      if (cfg.protocol === "gbn") {
        resend = [];
        for (let s = base; s < nextSeq; s++) resend.push(s);
        timers = [{ seq: base, at: t + TIMEOUT }];
      } else {
        timers = timers.filter((x) => x !== f);
        if (!acked[f.seq] && !resend.includes(f.seq)) resend.push(f.seq);
      }
    }

    // 3. the sender's link: one packet at a time, retransmissions first
    if (t >= linkFree && doneAt < 0) {
      if (resend.length) {
        const s = resend.shift()!;
        if (!acked[s]) transmit(t, s);
      } else if (nextSeq < N && nextSeq < base + W) {
        transmit(t, nextSeq);
        nextSeq++;
      }
    }

    if (doneAt >= 0 && inflight.length === 0) break;
  }

  const lastArrival = Math.max(0, ...packets.map((p) => p.arriveT ?? p.sendT + TX + PROP));
  const dataSent = packets.filter((p) => p.kind === "data" && !p.copy).length;
  const complete = doneAt >= 0;
  const finish = complete ? doneAt : t;
  return {
    packets,
    timeouts,
    deliveries,
    doneAt: finish,
    end: Math.max(finish, lastArrival),
    dataSent,
    retransmissions: dataSent - N,
    dupDelivered: deliveries.filter((d) => d.dup).length,
    outOfOrder: deliveries.filter((d) => d.outOfOrder).length,
    missing: N - new Set(deliveries.map((d) => d.seq)).size,
    maxBuffered,
    utilisation: finish > 0 ? (N * TX) / finish : 0,
    complete,
    ackedAt,
  };
}

/* ---------------- playground state ---------------- */

export type ChallengeId = "pipe" | "gbnWaste" | "cumulative" | "duplicate";

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "pipe", text: "On a clean link, make the transfer at least 4 times faster than stop-and-wait." },
  { id: "gbnWaste", text: "Lose one packet under go-back-N, then under selective repeat. Which resends more?" },
  { id: "cumulative", text: "Under go-back-N, lose the ACK for packet 2 and nothing else. Does anything get resent?" },
  { id: "duplicate", text: "Turn off the receiver's sequence check and lose one ACK. What does the app receive?" },
];

export interface State {
  protocol: Protocol;
  window: number;
  faults: Fault[];
  seqCheck: boolean;
  /** Simulation clock in ms. */
  t: number;
  prediction: string | null;
  /** Set once a go-back-N run with exactly one lost packet has played to the end. */
  revealed: boolean;
  done: ChallengeId[];
  /** Protocols that finished a run with exactly one lost packet and no other faults. */
  oneLossRuns: Protocol[];
}

export type Action =
  | { type: "protocol"; protocol: Protocol }
  | { type: "window"; window: number }
  | { type: "cycleFault"; seq: number }
  | { type: "setFault"; seq: number; fault: Fault }
  | { type: "preset"; name: Preset }
  | { type: "seqCheck"; on: boolean }
  | { type: "tick"; ms: number }
  | { type: "toEnd" }
  | { type: "rewind" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export type Preset = "clean" | "lose3" | "loseAck" | "random";
export const PRESET_LABEL: Record<Preset, string> = { clean: "Clean link", lose3: "Lose packet 3", loseAck: "Lose ACK 2", random: "Random 25% trouble" };

export const clean = (): Fault[] => new Array<Fault>(N).fill("ok");

export function init(): State {
  return { protocol: "sw", window: 4, faults: clean(), seqCheck: true, t: 0, prediction: null, revealed: false, done: [], oneLossRuns: [] };
}

export const configOf = (s: State): Config => ({ protocol: s.protocol, window: s.window, faults: s.faults, seqCheck: s.seqCheck });

/** A small seeded generator so "random" is the same every time (and testable). */
export function randomPlan(seed = 7): Fault[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return clean().map(() => {
    const r = rnd();
    if (r < 0.75) return "ok";
    return (["drop", "delay", "dup", "ackdrop"] as Fault[])[Math.floor(rnd() * 4)];
  });
}

export const isOneLoss = (f: Fault[]) => f.filter((x) => x === "drop").length === 1 && f.every((x) => x === "ok" || x === "drop");

function finish(s: State): State {
  const r = simulate(configOf(s));
  const done = new Set(s.done);
  const oneLoss = isOneLoss(s.faults) && s.seqCheck;
  const runs = oneLoss && !s.oneLossRuns.includes(s.protocol) ? [...s.oneLossRuns, s.protocol] : s.oneLossRuns;
  if (s.protocol !== "sw" && s.faults.every((f) => f === "ok") && r.doneAt * 4 <= simulate({ ...configOf(s), protocol: "sw" }).doneAt) done.add("pipe");
  if (runs.includes("gbn") && runs.includes("sr")) done.add("gbnWaste");
  if (s.protocol === "gbn" && s.seqCheck && s.faults[2] === "ackdrop" && s.faults.filter((f) => f !== "ok").length === 1 && r.retransmissions === 0) done.add("cumulative");
  if (!s.seqCheck && r.dupDelivered > 0 && s.faults.includes("ackdrop")) done.add("duplicate");
  return {
    ...s,
    t: r.end,
    oneLossRuns: runs,
    revealed: s.revealed || (oneLoss && s.protocol === "gbn"),
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
    case "protocol":
      return rewound(s, { protocol: a.protocol });
    case "window":
      return rewound(s, { window: Math.min(8, Math.max(2, a.window)) });
    case "seqCheck":
      return rewound(s, { seqCheck: a.on });
    case "cycleFault": {
      const f = [...s.faults];
      f[a.seq] = FAULTS[(FAULTS.indexOf(f[a.seq]) + 1) % FAULTS.length];
      return rewound(s, { faults: f });
    }
    case "setFault": {
      const f = [...s.faults];
      f[a.seq] = a.fault;
      return rewound(s, { faults: f });
    }
    case "preset": {
      const faults = a.name === "clean" ? clean()
        : a.name === "lose3" ? clean().map((_, i) => (i === 3 ? "drop" : "ok") as Fault)
          : a.name === "loseAck" ? clean().map((_, i) => (i === 2 ? "ackdrop" : "ok") as Fault)
            : randomPlan();
      return rewound(s, { faults });
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

/** The same fault plan on all three protocols, for the comparison bars and the result line. */
export function compare(s: State): Record<Protocol, Result> {
  return Object.fromEntries(PROTOCOLS.map((p) => [p, simulate({ ...configOf(s), protocol: p })])) as Record<Protocol, Result>;
}
