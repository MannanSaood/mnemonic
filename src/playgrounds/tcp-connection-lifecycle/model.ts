// TCP lifecycle playground: one short connection (connect, a request, a response, close) between
// a client and a database server, drawn as a sequence diagram with each end's state beside it.
// The reader drops any segment on its first trip, closes the port, puts a firewall in the way,
// makes the server reset mid-request, and sets the client's connect timeout.
//
// After this, the reader can answer: "What does each end believe at each moment of a connection,
// and why does a silently dropped SYN hang my client for minutes when a closed port fails at once?"
// Core insight: TCP state lives only in the two endpoints. Every lost segment is repaired by the
// sender's timer (a lost pure ACK is covered by the next segment), a RST ends things at once, and
// silence is the expensive case: the client retries its SYN with backoff for about two minutes
// unless the application sets a connect timeout.
//
// Plain state + a pure step function. simulate() is a deterministic event-driven model of the
// RFC 9293 state machine (a subset: no simultaneous open), so every scenario is testable.

export type Side = "c" | "s";
export type TcpState =
  | "CLOSED" | "LISTEN" | "SYN-SENT" | "SYN-RECEIVED" | "ESTABLISHED"
  | "FIN-WAIT-1" | "FIN-WAIT-2" | "CLOSE-WAIT" | "LAST-ACK" | "CLOSING" | "TIME-WAIT";
export type Label = "syn" | "synack" | "ack3" | "req" | "resp" | "ackresp" | "fin1" | "finack" | "fin2" | "lastack" | "rst" | "ack";
export type ServerMode = "listen" | "closed" | "filtered";
export type ConnectTimeout = "none" | "3s";

/** Segments the reader may drop on their first trip, in the order they normally appear. */
export const DROPPABLE: Label[] = ["syn", "synack", "ack3", "req", "resp", "fin1", "finack", "fin2", "lastack"];
export const LABEL_NAME: Record<Label, string> = {
  syn: "SYN", synack: "SYN-ACK", ack3: "handshake ACK", req: "request", resp: "response", ackresp: "ACK",
  fin1: "client FIN", finack: "ACK of FIN", fin2: "server FIN", lastack: "last ACK", rst: "RST", ack: "ACK",
};

export const ONE_WAY = 20; // ms, so a round trip is 40 ms
export const INITIAL_RTO = 1000; // RFC 6298 (2.1): 1 s before any RTT sample
export const SYN_RETRIES = 6; // Linux tcp_syn_retries default
export const SYNACK_RETRIES = 5; // Linux tcp_synack_retries default
export const TIME_WAIT_MS = 60_000; // Linux holds TIME-WAIT for 60 s
export const CONNECT_TIMEOUT_MS = 3000;
export const CLIENT_ISS = 2981;
export const SERVER_ISS = 7410;
export const REQ_LEN = 120;
export const RESP_LEN = 900;

export interface Config { mode: ServerMode; drops: Label[]; abort: boolean; timeout: ConnectTimeout }

export interface Segment {
  kind: "seg";
  id: number;
  from: Side;
  label: Label;
  flags: string[];
  seq: number;
  ack: number | null;
  len: number;
  sendT: number;
  arriveT: number | null;
  /** Why it never arrived. */
  lostBy?: "you" | "firewall";
  retrans: boolean;
  /** Both ends' states just after it was sent, and just after it arrived. */
  atSend: Record<Side, TcpState>;
  atArrive?: Record<Side, TcpState>;
}

export interface Note { kind: "note"; id: number; t: number; side: Side; text: string; tone: "ok" | "bad" | "info"; states: Record<Side, TcpState> }
export type Row = Segment | Note;

export type Outcome =
  | { kind: "ok"; connectedAt: number; responseAt: number }
  | { kind: "refused"; at: number }
  | { kind: "timeout"; at: number; by: "kernel" | "app" }
  | { kind: "reset"; at: number };

export interface Result {
  rows: Row[];
  outcome: Outcome;
  segments: number;
  retransmissions: number;
  /** Final time of the model (TIME-WAIT expiry included). */
  end: number;
  /** Which side waited in TIME-WAIT, if any. */
  timeWait: Side | null;
  /** The server reached ESTABLISHED because a data segment carried the ACK. */
  establishedByData: boolean;
  final: Record<Side, TcpState>;
}

interface Pending { label: Label; flags: string[]; seq: number; len: number; end: number; rto: number; tries: number; at: number }
interface Ep { state: TcpState; iss: number; sndNxt: number; rcvNxt: number; queue: Pending[] }

type Ev =
  | { at: number; n: number; type: "arrive"; seg: Segment }
  | { at: number; n: number; type: "timewait" }
  | { at: number; n: number; type: "deadline" }
  | { at: number; n: number; type: "serverClose" };

const consumes = (flags: string[], len: number) => len + (flags.includes("SYN") ? 1 : 0) + (flags.includes("FIN") ? 1 : 0);

export function simulate(cfg: Config): Result {
  const rows: Row[] = [];
  const evs: Ev[] = [];
  let n = 0, rid = 0;
  const ep: Record<Side, Ep> = {
    c: { state: "CLOSED", iss: CLIENT_ISS, sndNxt: CLIENT_ISS, rcvNxt: 0, queue: [] },
    s: { state: cfg.mode === "listen" ? "LISTEN" : "CLOSED", iss: SERVER_ISS, sndNxt: SERVER_ISS, rcvNxt: 0, queue: [] },
  };
  const firstSent = new Set<Label>();
  let outcome: Outcome | null = null;
  let connectedAt = -1;
  let retransmissions = 0, segments = 0;
  let timeWait: Side | null = null;
  let establishedByData = false;

  const states = (): Record<Side, TcpState> => ({ c: ep.c.state, s: ep.s.state });
  const other = (x: Side): Side => (x === "c" ? "s" : "c");
  const note = (t: number, side: Side, text: string, tone: Note["tone"] = "info") => rows.push({ kind: "note", id: rid++, t, side, text, tone, states: states() });
  const push = (e: { at: number; type: Ev["type"]; seg?: Segment }) => evs.push({ ...e, n: n++ } as Ev);

  const send = (t: number, from: Side, label: Label, flags: string[], opts: { seq?: number; len?: number; reliable?: boolean; retrans?: boolean; ack?: number | null } = {}) => {
    const e = ep[from];
    const seq = opts.seq ?? e.sndNxt;
    const len = opts.len ?? 0;
    const ack = opts.ack !== undefined ? opts.ack : flags.includes("ACK") ? e.rcvNxt : null;
    let lostBy: Segment["lostBy"];
    if (cfg.mode === "filtered" && from === "c" && label === "syn") lostBy = "firewall";
    else if (cfg.drops.includes(label) && !firstSent.has(label)) lostBy = "you";
    firstSent.add(label);
    segments++;
    if (opts.retrans) retransmissions++;
    if (opts.reliable && !opts.retrans) {
      const end = seq + consumes(flags, len);
      e.queue.push({ label, flags, seq, len, end, rto: INITIAL_RTO, tries: 0, at: t + INITIAL_RTO });
      if (end > e.sndNxt) e.sndNxt = end;
    }
    const seg: Segment = { kind: "seg", id: rid++, from, label, flags, seq, ack, len, sendT: t, arriveT: lostBy ? null : t + ONE_WAY, lostBy, retrans: !!opts.retrans, atSend: states() };
    rows.push(seg);
    if (!lostBy) push({ at: t + ONE_WAY, type: "arrive", seg });
  };

  const ackUpTo = (e: Ep, ack: number | null) => {
    if (ack === null) return;
    e.queue = e.queue.filter((p) => p.end > ack);
  };
  const fail = (o: Outcome) => { if (!outcome) outcome = o; };

  const setState = (side: Side, st: TcpState) => { ep[side].state = st; };

  const clientOnEstablished = (t: number) => {
    connectedAt = t;
    note(t, "c", "connect() returns. The app sends its query at once.", "ok");
    send(t, "c", "req", ["ACK", "PSH"], { len: REQ_LEN, reliable: true });
  };

  const onArrive = (t: number, seg: Segment) => {
    // what the receiver's state is once the protocol has handled the segment, before its app reacts
    const snap = () => { if (!seg.atArrive) seg.atArrive = states(); };
    const to = other(seg.from);
    const e = ep[to];
    const f = seg.flags;
    if (to === "s") {
      // ---------------- server
      if (e.state === "CLOSED") {
        if (!f.includes("RST")) {
          note(t, "s", "No socket listens on this port, so the kernel answers with a reset.", "bad");
          send(t, "s", "rst", ["RST", "ACK"], { seq: 0, ack: seg.seq + consumes(f, seg.len) });
        }
        return;
      }
      if (e.state === "LISTEN" && f.includes("SYN")) {
        e.rcvNxt = seg.seq + 1;
        setState("s", "SYN-RECEIVED");
        send(t, "s", "synack", ["SYN", "ACK"], { reliable: true });
        return;
      }
      if (e.state === "SYN-RECEIVED") {
        if (f.includes("SYN")) {
          // the client never got our SYN-ACK: say it again
          const p = e.queue.find((q) => q.label === "synack");
          if (p) send(t, "s", "synack", ["SYN", "ACK"], { seq: p.seq, retrans: true });
          return;
        }
        if (seg.ack !== null && seg.ack >= e.iss + 1) {
          ackUpTo(e, seg.ack);
          setState("s", "ESTABLISHED");
          if (seg.len > 0) {
            establishedByData = true;
            note(t, "s", "The handshake ACK was lost, but the request carries the same ACK number. Connection established.", "ok");
          } else note(t, "s", "accept() returns the new connection.", "ok");
        }
      }
      if (e.state === "ESTABLISHED" || e.state === "CLOSE-WAIT" || e.state === "LAST-ACK") {
        ackUpTo(e, seg.ack);
        if (e.state === "LAST-ACK" && !e.queue.some((q) => q.label === "fin2")) {
          setState("s", "CLOSED");
          note(t, "s", "Its FIN is acknowledged. The server forgets the connection.", "info");
          return;
        }
        if (seg.len > 0) {
          if (seg.seq === e.rcvNxt) {
            e.rcvNxt += seg.len;
            if (cfg.abort) {
              snap();
              note(t, "s", "The database process crashes mid-query. Its kernel resets the connection.", "bad");
              send(t, "s", "rst", ["RST", "ACK"]);
              e.queue = [];
              setState("s", "CLOSED");
              return;
            }
            send(t, "s", "resp", ["ACK", "PSH"], { len: RESP_LEN, reliable: true });
          } else {
            send(t, "s", "ack", ["ACK"]); // a copy we already have
          }
        }
        if (f.includes("FIN")) {
          if (seg.seq + seg.len === e.rcvNxt && e.state === "ESTABLISHED") {
            e.rcvNxt += 1;
            setState("s", "CLOSE-WAIT");
            send(t, "s", "finack", ["ACK"]);
            note(t, "s", "read() returns 0: the client is done. The server app calls close().", "info");
            push({ at: t + 1, type: "serverClose" });
          } else {
            send(t, "s", "finack", ["ACK"]); // a resent FIN
          }
        }
      }
      return;
    }

    // ---------------- client
    if (e.state === "SYN-SENT") {
      if (f.includes("RST") && seg.ack === e.iss + 1) {
        e.queue = [];
        setState("c", "CLOSED");
        note(t, "c", "connect() fails at once: ECONNREFUSED.", "bad");
        fail({ kind: "refused", at: t });
        return;
      }
      if (f.includes("SYN") && f.includes("ACK") && seg.ack === e.iss + 1) {
        e.rcvNxt = seg.seq + 1;
        ackUpTo(e, seg.ack);
        setState("c", "ESTABLISHED");
        send(t, "c", "ack3", ["ACK"]);
        snap();
        clientOnEstablished(t);
      }
      return;
    }
    if (e.state === "CLOSED") return;
    if (f.includes("RST")) {
      e.queue = [];
      setState("c", "CLOSED");
      note(t, "c", "read() fails: ECONNRESET, connection reset by peer.", "bad");
      fail({ kind: "reset", at: t });
      return;
    }
    if (f.includes("SYN")) {
      // our ACK was lost; the server resent its SYN-ACK
      send(t, "c", "ack3", ["ACK"]);
      return;
    }
    ackUpTo(e, seg.ack);
    if (e.state === "FIN-WAIT-1" && !e.queue.some((q) => q.label === "fin1")) {
      setState("c", "FIN-WAIT-2");
      if (!f.includes("FIN")) note(t, "c", "Its FIN is acknowledged. The client's half is closed; it waits for the server's FIN.", "info");
    }
    if (e.state === "CLOSING" && !e.queue.some((q) => q.label === "fin1")) {
      setState("c", "TIME-WAIT");
      push({ at: t + TIME_WAIT_MS, type: "timewait" });
    }
    if (seg.len > 0) {
      if (seg.seq === e.rcvNxt) {
        e.rcvNxt += seg.len;
        send(t, "c", "ackresp", ["ACK"]);
        snap();
        if (!outcome) outcome = { kind: "ok", connectedAt, responseAt: t };
        note(t, "c", "The app has its rows and calls close().", "ok");
        setState("c", "FIN-WAIT-1");
        send(t, "c", "fin1", ["FIN", "ACK"], { reliable: true });
      } else send(t, "c", "ack", ["ACK"]);
    }
    if (f.includes("FIN")) {
      if (e.state === "TIME-WAIT") {
        send(t, "c", "lastack", ["ACK"]);
        note(t, "c", "A resent FIN: the client is still in TIME-WAIT, so it can ACK it again.", "info");
        return;
      }
      e.rcvNxt = seg.seq + seg.len + 1;
      if (e.state === "FIN-WAIT-2") {
        setState("c", "TIME-WAIT");
        send(t, "c", "lastack", ["ACK"]);
        push({ at: t + TIME_WAIT_MS, type: "timewait" });
      } else if (e.state === "FIN-WAIT-1") {
        setState("c", "CLOSING");
        send(t, "c", "lastack", ["ACK"]);
      }
    }
  };

  // start: the client calls connect()
  setState("c", "SYN-SENT");
  note(0, "c", "The app calls connect().", "info");
  send(0, "c", "syn", ["SYN"], { reliable: true });
  if (cfg.timeout === "3s") push({ at: CONNECT_TIMEOUT_MS, type: "deadline" });

  let t = 0;
  for (let guard = 0; guard < 2000; guard++) {
    // the next thing to happen: an event or a retransmit timer
    let next = Infinity;
    for (const e of evs) next = Math.min(next, e.at);
    for (const side of ["c", "s"] as Side[]) for (const p of ep[side].queue) next = Math.min(next, p.at);
    if (next === Infinity) break;
    t = next;

    const due = evs.filter((e) => e.at === t).sort((a, b) => a.n - b.n);
    for (const e of due) {
      evs.splice(evs.indexOf(e), 1);
      if (e.type === "arrive") {
        onArrive(t, e.seg);
        if (!e.seg.atArrive) e.seg.atArrive = states();
      } else if (e.type === "timewait") {
        if (ep.c.state === "TIME-WAIT") {
          setState("c", "CLOSED");
          timeWait = "c";
          note(t, "c", `TIME-WAIT ends after ${TIME_WAIT_MS / 1000} s. The socket is gone.`, "info");
        }
      } else if (e.type === "deadline") {
        if (ep.c.state === "SYN-SENT") {
          ep.c.queue = [];
          setState("c", "CLOSED");
          note(t, "c", "The app's 3 s connect timeout fires. It closes the socket and returns an error.", "bad");
          fail({ kind: "timeout", at: t, by: "app" });
        }
      } else if (e.type === "serverClose") {
        if (ep.s.state === "CLOSE-WAIT") {
          setState("s", "LAST-ACK");
          send(t, "s", "fin2", ["FIN", "ACK"], { reliable: true });
        }
      }
    }

    for (const side of ["c", "s"] as Side[]) {
      const e = ep[side];
      for (const p of [...e.queue]) {
        if (p.at !== t || !e.queue.includes(p)) continue;
        p.tries++;
        const limit = p.label === "syn" ? SYN_RETRIES : p.label === "synack" ? SYNACK_RETRIES : 15;
        if (p.tries > limit) {
          e.queue = e.queue.filter((q) => q !== p);
          if (p.label === "syn") {
            setState("c", "CLOSED");
            note(t, "c", `After ${SYN_RETRIES} resends the kernel gives up. connect() fails: ETIMEDOUT, ${Math.round(t / 1000)} s after the call.`, "bad");
            fail({ kind: "timeout", at: t, by: "kernel" });
          } else if (p.label === "synack") {
            setState("s", "LISTEN");
            note(t, "s", "No ACK ever came. The server drops the half-open connection.", "info");
          }
          continue;
        }
        p.rto *= 2;
        p.at = t + p.rto;
        note(t, side, `Retransmit timer fires: resend the ${LABEL_NAME[p.label]}. Next wait ${p.rto / 1000} s.`, "info");
        const flags = p.flags;
        send(t, side, p.label, flags, { seq: p.seq, len: p.len, retrans: true });
      }
    }
  }

  return {
    rows: rows.sort((a, b) => timeOf(a) - timeOf(b) || a.id - b.id),
    outcome: outcome ?? { kind: "timeout", at: t, by: "kernel" },
    segments,
    retransmissions,
    end: t,
    timeWait,
    establishedByData,
    final: states(),
  };
}

export const startStates = (mode: ServerMode): Record<Side, TcpState> => ({ c: "CLOSED", s: mode === "listen" ? "LISTEN" : "CLOSED" });

export const timeOf = (r: Row) => (r.kind === "seg" ? r.sendT : r.t);

/** Both ends' states at the moment of a row: a row is a snapshot in time, like a line of `ss`. */
export function rowStates(r: Row): Record<Side, TcpState> {
  return r.kind === "note" ? { ...r.states } : { ...r.atSend };
}

/* ---------------- playground state ---------------- */

export type ChallengeId = "refused" | "hangThenFix" | "lostAck" | "reset";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "refused", text: "Make connect() fail at once." },
  { id: "hangThenFix", text: "Make connect() hang for minutes, then make the same fault cost 3 seconds." },
  { id: "lostAck", text: "Drop the last ACK of the handshake. Does the query still get through, and who resends what?" },
  { id: "reset", text: "Crash the server mid-query and watch both ends' states." },
];

export interface State {
  mode: ServerMode;
  drops: Label[];
  abort: boolean;
  timeout: ConnectTimeout;
  /** How many rows of the timeline are shown. */
  cursor: number;
  prediction: string | null;
  revealed: boolean;
  done: ChallengeId[];
  /** Saw a kernel-length hang with the firewall (for the hang-then-fix challenge). */
  sawHang: boolean;
}

export type Action =
  | { type: "mode"; mode: ServerMode }
  | { type: "toggleDrop"; label: Label }
  | { type: "abort"; on: boolean }
  | { type: "timeout"; value: ConnectTimeout }
  | { type: "next" }
  | { type: "toEnd" }
  | { type: "rewind" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { mode: "listen", drops: [], abort: false, timeout: "none", cursor: 0, prediction: null, revealed: false, done: [], sawHang: false };
}

export const configOf = (s: State): Config => ({ mode: s.mode, drops: s.drops, abort: s.abort, timeout: s.timeout });

function finish(s: State): State {
  const r = simulate(configOf(s));
  const done = new Set(s.done);
  const o = r.outcome;
  const hang = s.mode === "filtered" && o.kind === "timeout" && o.by === "kernel";
  const sawHang = s.sawHang || hang;
  if (o.kind === "refused") done.add("refused");
  if (sawHang && s.mode === "filtered" && o.kind === "timeout" && o.by === "app") done.add("hangThenFix");
  if (s.drops.includes("ack3") && o.kind === "ok" && r.establishedByData) done.add("lostAck");
  if (o.kind === "reset") done.add("reset");
  return {
    ...s,
    cursor: r.rows.length,
    sawHang,
    revealed: s.revealed || hang,
    done: CHALLENGES.map((c) => c.id).filter((id) => done.has(id)),
  };
}

const rewound = (s: State, patch: Partial<State>): State => ({ ...s, ...patch, cursor: 0 });

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "mode":
      return rewound(s, { mode: a.mode });
    case "abort":
      return rewound(s, { abort: a.on });
    case "timeout":
      return rewound(s, { timeout: a.value });
    case "toggleDrop":
      return rewound(s, { drops: s.drops.includes(a.label) ? s.drops.filter((d) => d !== a.label) : [...s.drops, a.label] });
    case "rewind":
      return { ...s, cursor: 0 };
    case "toEnd":
      return finish(s);
    case "next": {
      const total = simulate(configOf(s)).rows.length;
      if (s.cursor >= total) return s;
      return s.cursor + 1 >= total ? finish(s) : { ...s, cursor: s.cursor + 1 };
    }
  }
}
