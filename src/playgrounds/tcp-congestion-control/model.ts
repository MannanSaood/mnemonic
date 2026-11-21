// Congestion control playground: TCP Reno's window, one RTT at a time, on a bottleneck link.
//
// After this, the reader can answer: how does a TCP sender find a link's capacity it was never
// told, and why does the same rule (add one packet per RTT, halve on loss) leave two flows
// sharing the link evenly? (It grows cwnd until the bottleneck buffer overflows, treats the drop
// as the signal, halves, and climbs again: the sawtooth. Halving cuts the bigger flow by more,
// adding treats both alike, so the gap between two flows shrinks at every loss.)
//
// A round-based fluid model: each round is one RTT. Each flow sends cwnd packets; the link
// delivers C packets per RTT and queues up to B more; anything beyond C + B is dropped, and every
// TCP flow that was sending sees a loss (drops from a full tail-drop queue hit everyone). Loss
// with a window of 4 or more is repaired by fast retransmit (halve). Smaller windows, or a whole
// lost window, wait for the retransmission timeout (RTO) and restart from one packet.
// Plain state + a pure step function, so it can be tested without a browser.

export const BASE_RTT_MS = 40;
export const PACKET_BYTES = 1500;
/** Initial window: 10 segments (RFC 6928, the Linux default). */
export const IW = 10;
/** Linux's minimum RTO is 200 ms: 5 rounds of silence at a 40 ms RTT. */
export const RTO_ROUNDS = 5;
/** A 200 KB response, as in the lesson: about 140 full-size segments. */
export const RESPONSE_PACKETS = 140;
export const HISTORY = 400;

export type Rate = 6 | 12 | 24;
export const RATES: Rate[] = [6, 12, 24];
/** Packets per RTT the link can carry: Mbit/s x 40 ms / (1500 B x 8). This is the BDP. */
export const capacity = (r: Rate) => Math.round((r * 1e6 * BASE_RTT_MS) / 1000 / (PACKET_BYTES * 8));

export type Buffer = "quarter" | "one" | "two";
export const BUFFERS: Buffer[] = ["quarter", "one", "two"];
export const BUFFER_NAME: Record<Buffer, string> = { quarter: "¼ BDP", one: "1 BDP", two: "2 BDP" };
export const bufferPackets = (r: Rate, b: Buffer) => Math.round(capacity(r) * (b === "quarter" ? 0.25 : b === "one" ? 1 : 2));

export type FlowId = "A" | "B";
export type Phase = "slow start" | "avoidance" | "timeout";

export interface Flow {
  on: boolean;
  cwnd: number;
  ssthresh: number; // Infinity until the first loss (RFC 5681: "arbitrarily high")
  phase: Phase;
  rtoLeft: number;
  delivered: number;
  fastRecoveries: number;
  timeouts: number;
  joinedAt: number;
}

export type Mark = "ss-exit" | "fast" | "timeout";
export interface Sample {
  t: number;
  ms: number;
  cwnd: Record<FlowId, number | null>;
  ssthresh: Record<FlowId, number | null>;
  sent: Record<FlowId, number>;
  delivered: Record<FlowId, number>;
  /** What the UDP sender got through. */
  udp: number;
  queue: number;
  capacity: number;
  limit: number;
  marks: { flow: FlowId; kind: Mark }[];
}

export interface LogLine { id: number; ok: boolean; text: string; path: string[] }

export interface State {
  rate: Rate;
  buffer: Buffer;
  udp: boolean;
  t: number;
  ms: number;
  flows: Record<FlowId, Flow>;
  /** Losses the reader asked for, applied on the next round. */
  pending: { drop: boolean; window: boolean };
  history: Sample[];
  /** Round at which flow A had delivered the 200 KB response. */
  responseAt: number | null;
  log: LogLine[];
  seq: number;
}

export type Action =
  | { type: "tick"; n?: number }
  | { type: "rate"; rate: Rate }
  | { type: "buffer"; buffer: Buffer }
  | { type: "dropOne" }
  | { type: "dropWindow" }
  | { type: "flowB" }
  | { type: "udp" }
  | { type: "reset" };

const fresh = (on: boolean, t = 0): Flow => ({
  on, cwnd: IW, ssthresh: Infinity, phase: "slow start", rtoLeft: 0, delivered: 0, fastRecoveries: 0, timeouts: 0, joinedAt: t,
});

export function init(): State {
  return {
    rate: 12, buffer: "one", udp: false, t: 0, ms: 0,
    flows: { A: fresh(true), B: fresh(false) },
    pending: { drop: false, window: false },
    history: [], responseAt: null, log: [], seq: 0,
  };
}

/** The unresponsive UDP sender takes half the link and never backs off. */
export const udpRate = (st: State) => (st.udp ? Math.round(capacity(st.rate) / 2) : 0);

function say(st: State, ok: boolean, text: string, path: string[]): State {
  return { ...st, seq: st.seq + 1, log: [{ id: st.seq, ok, text, path }, ...st.log].slice(0, 6) };
}

/** Fast retransmit + fast recovery (RFC 5681 3.2), seen at RTT granularity: halve and go on. */
function halve(f: Flow, flight: number): Flow {
  const ssthresh = Math.max(Math.floor(flight / 2), 2);
  return { ...f, ssthresh, cwnd: ssthresh, phase: "avoidance", fastRecoveries: f.fastRecoveries + 1 };
}
/** RTO (RFC 5681 3.1): ssthresh = half the flight, then wait, then restart from one segment. */
function timeout(f: Flow, flight: number): Flow {
  return { ...f, ssthresh: Math.max(Math.floor(flight / 2), 2), cwnd: 1, phase: "timeout", rtoLeft: RTO_ROUNDS, timeouts: f.timeouts + 1 };
}

function round(st: State): State {
  const C = capacity(st.rate), B = bufferPackets(st.rate, st.buffer), U = udpRate(st);
  const ids: FlowId[] = (["A", "B"] as FlowId[]).filter((id) => st.flows[id].on);
  const sent: Record<FlowId, number> = { A: 0, B: 0 };
  for (const id of ids) sent[id] = st.flows[id].phase === "timeout" ? 0 : st.flows[id].cwnd;
  const total = sent.A + sent.B + U;
  const overflow = total > C + B;
  const share = total > 0 ? Math.min(1, C / total) : 0;
  const queue = Math.max(0, Math.min(total - C, B));
  const delivered: Record<FlowId, number> = { A: sent.A * share, B: sent.B * share };
  const marks: Sample["marks"] = [];
  // The loss is seen when the flight first exceeds what the link and queue hold, so a flow
  // halves the part of its window that fitted, not a window that slow start had already doubled.
  const fitted = (id: FlowId) => (overflow ? Math.floor((sent[id] * (C + B)) / total) : sent[id]);
  let next: State = st;
  const flows = { ...st.flows };

  for (const id of ids) {
    let f = { ...flows[id], delivered: flows[id].delivered + delivered[id] };
    const forcedWindow = id === "A" && st.pending.window;
    const forcedOne = id === "A" && st.pending.drop;
    if (f.phase === "timeout") {
      f.rtoLeft--;
      if (f.rtoLeft <= 0) f = { ...f, phase: "slow start", cwnd: 1 };
    } else if (forcedWindow || ((overflow || forcedOne) && f.cwnd < 4)) {
      f = timeout(f, fitted(id));
      marks.push({ flow: id, kind: "timeout" });
      next = say(next, false, forcedWindow
        ? `Flow ${id}: the whole window was lost, so no duplicate ACKs came back. It waits ${RTO_ROUNDS * BASE_RTT_MS} ms for the timeout, then starts again from 1 packet. ssthresh = ${f.ssthresh}.`
        : `Flow ${id}: a packet was lost with only ${sent[id]} in flight, too few for 3 duplicate ACKs. Timeout: ${RTO_ROUNDS * BASE_RTT_MS} ms of silence, then 1 packet.`,
        [`flow ${id}`, "loss", "no dup ACKs", `RTO ${RTO_ROUNDS * BASE_RTT_MS} ms`, "cwnd 1"]);
    } else if (overflow || forcedOne) {
      const was = f.phase;
      f = halve(f, fitted(id));
      marks.push({ flow: id, kind: "fast" });
      next = say(next, true, forcedOne
        ? `Flow ${id}: you dropped one packet. The next 3 segments each produced a duplicate ACK, so it resent the hole and halved: cwnd ${sent[id]} → ${f.cwnd}.`
        : `Flow ${id}: ${total} packets met a link and queue that hold ${C + B}. The queue overflowed, 3 duplicate ACKs came back, and cwnd went ${fitted(id)} → ${f.cwnd}${was === "slow start" ? ". Slow start is over" : ""}.`,
        [`flow ${id}`, overflow ? "queue full" : "you dropped 1", "3 dup ACKs", "halve", `cwnd ${f.cwnd}`]);
    } else if (f.phase === "slow start") {
      const grown = Math.min(f.cwnd * 2, f.ssthresh);
      f = { ...f, cwnd: grown };
      if (grown >= f.ssthresh) {
        f.phase = "avoidance";
        marks.push({ flow: id, kind: "ss-exit" });
      }
    } else {
      f = { ...f, cwnd: f.cwnd + 1 };
    }
    flows[id] = f;
  }

  const t = st.t + 1;
  const ms = st.ms + BASE_RTT_MS * (1 + queue / C);
  const sample: Sample = {
    t, ms, queue, udp: U * share, capacity: C, limit: C + B, sent, delivered, marks,
    cwnd: { A: sent.A, B: flows.B.on ? sent.B : null },
    ssthresh: {
      A: Number.isFinite(st.flows.A.ssthresh) ? st.flows.A.ssthresh : null,
      B: flows.B.on && Number.isFinite(st.flows.B.ssthresh) ? st.flows.B.ssthresh : null,
    },
  };
  const responseAt = next.responseAt ?? (flows.A.delivered >= RESPONSE_PACKETS ? t : null);
  if (responseAt !== null && next.responseAt === null)
    next = say(next, true, `Flow A has delivered 200 KB after ${t} RTTs (${Math.round(ms)} ms). On a full-speed pipe it would have taken 1 RTT plus ${((RESPONSE_PACKETS * PACKET_BYTES * 8) / (st.rate * 1000)).toFixed(0)} ms.`,
      ["flow A", "200 KB", `${t} RTTs`]);
  return {
    ...next, t, ms, flows, responseAt,
    pending: { drop: false, window: false },
    history: [...st.history, sample].slice(-HISTORY),
  };
}

/* ---------------- measures the view and the tests share ---------------- */

/** Share of the link's capacity that carried data over the last n rounds (0..1). */
export function utilization(st: State, n = 60): number {
  const h = st.history.slice(-n);
  if (!h.length) return 0;
  return h.reduce((s, x) => s + x.delivered.A + x.delivered.B + x.udp, 0) / h.reduce((s, x) => s + x.capacity, 0);
}

/** Worst queueing delay over the last n rounds, in ms. */
export function maxQueueMs(st: State, n = 60): number {
  return Math.max(0, ...st.history.slice(-n).map((x) => (x.queue / x.capacity) * BASE_RTT_MS));
}

/** Flow A's share of what both flows delivered over the last n rounds, while both were on. */
export function shareA(st: State, n = 40): number | null {
  const h = st.history.slice(-n).filter((x) => x.cwnd.B !== null);
  if (h.length < Math.min(n, 10)) return null;
  const a = h.reduce((s, x) => s + x.delivered.A, 0), b = h.reduce((s, x) => s + x.delivered.B, 0);
  return a + b > 0 ? a / (a + b) : null;
}

/** Jain's fairness index for two flows: 1 is perfectly even, 0.5 is one flow taking everything. */
export const jain = (a: number) => 1 / (2 * (a * a + (1 - a) * (1 - a)));

export interface Goals { found: boolean; full: boolean; fair: boolean; timeout: boolean }
export function goals(st: State, seen: Goals): Goals {
  const s = shareA(st);
  return {
    found: seen.found || st.history.some((x) => x.marks.some((m) => m.kind === "fast" && m.flow === "A")),
    full: seen.full || (st.buffer === "one" && st.history.length >= 60 && utilization(st) > 0.99 && !st.flows.B.on && !st.udp),
    fair: seen.fair || (s !== null && Math.abs(s - 0.5) < 0.05 && st.t - st.flows.B.joinedAt >= 40),
    timeout: seen.timeout || st.flows.A.timeouts > 0,
  };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "tick": {
      let s = st;
      for (let i = 0; i < (a.n ?? 1); i++) s = round(s);
      return s;
    }
    case "rate":
      return say({ ...st, rate: a.rate }, true, `The link is now ${a.rate} Mbit/s: ${capacity(a.rate)} packets per RTT, plus a queue of ${bufferPackets(a.rate, st.buffer)}. Nobody tells the senders.`, ["link", `${a.rate} Mbit/s`]);
    case "buffer":
      return say({ ...st, buffer: a.buffer }, true, `The router queue now holds ${bufferPackets(st.rate, a.buffer)} packets (${BUFFER_NAME[a.buffer]}).`, ["queue", BUFFER_NAME[a.buffer]]);
    case "dropOne":
      return { ...st, pending: { ...st.pending, drop: true } };
    case "dropWindow":
      return { ...st, pending: { ...st.pending, window: true } };
    case "flowB": {
      if (st.flows.B.on) return say({ ...st, flows: { ...st.flows, B: fresh(false) } }, true, "Flow B finished and left. Flow A has the link to itself again.", ["flow B", "closed"]);
      return say({ ...st, flows: { ...st.flows, B: fresh(true, st.t) } }, true, `Flow B opens a connection and starts at ${IW} packets in slow start, while flow A is at ${st.flows.A.cwnd}.`, ["flow B", "SYN", `cwnd ${IW}`]);
    }
    case "udp":
      return say({ ...st, udp: !st.udp }, st.udp, !st.udp
        ? `An unresponsive UDP sender now pushes ${Math.round(capacity(st.rate) / 2)} packets per RTT and ignores every loss.`
        : "The UDP sender stopped.", ["udp", st.udp ? "off" : "on"]);
  }
}
