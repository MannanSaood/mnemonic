// Channel playground: one live hchan (ring buffer, sendx/recvx, recvq and sendq of parked
// goroutines) with three sender and two receiver goroutines around it.
//
// Purpose. After this, the reader can answer: "When I send on this channel, does my goroutine
// keep running or park, and where does the value go?" The runtime checks in a fixed order:
// a receiver already parked on recvq gets the value copied straight onto its stack (the buffer
// is skipped, even on a buffered channel); otherwise a free slot takes it; otherwise the sender
// parks on sendq. Receives mirror it. Close wakes every waiter: receivers get the zero value,
// senders panic.
//
// The steps follow chansend, chanrecv and closechan in runtime/chan.go. Every operation takes
// the channel's one lock, which the model counts.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const SENDERS = ["S1", "S2", "S3"] as const;
export const RECEIVERS = ["R1", "R2"] as const;
export type Gid = (typeof SENDERS)[number] | (typeof RECEIVERS)[number];
export const ALL: Gid[] = [...SENDERS, ...RECEIVERS];
export const CAPS = [0, 1, 2, 3, 4] as const;

export type GStatus = "running" | "parked" | "panicked";
export interface G {
  id: Gid;
  role: "send" | "recv";
  status: GStatus;
  /** Receivers: the last value received ("" is the zero value). */
  got: string | null;
  /** Receivers: the ok of `v, ok := <-ch` for the last receive. */
  ok: boolean | null;
  /** Senders: the value it is parked with. */
  holding: string | null;
}

export type EvKind = "handoff" | "buffer" | "park" | "take" | "refill" | "zero" | "panic" | "close" | "closeTwice";
export interface Ev { id: number; kind: EvKind; ok: boolean; path: string[]; text: string }

export interface Stats {
  sends: number; recvs: number;
  /** Values copied straight from a sender's stack to a receiver's, skipping the buffer. */
  handoffs: number;
  /** Values that went through a buffer slot. */
  buffered: number;
  parks: number; wakes: number; locks: number; panics: number; zeroReads: number;
}
const zero = (): Stats => ({ sends: 0, recvs: 0, handoffs: 0, buffered: 0, parks: 0, wakes: 0, locks: 0, panics: 0, zeroReads: 0 });

export type ChallengeId = "skipBuffer" | "parkSender" | "refill" | "closeWaiters";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "skipBuffer", text: "On a buffered channel, get a value to a receiver without it touching the buffer." },
  { id: "parkSender", text: "On a buffered channel, keep sending until a sender parks on sendq." },
  { id: "refill", text: "With a sender parked and the buffer full, receive once. Watch where the parked value goes." },
  { id: "closeWaiters", text: "Close the channel while goroutines are parked on it." },
];

export type Guess = "buffer" | "park" | "direct";

export interface State {
  cap: number;
  buf: (string | null)[];
  sendx: number;
  recvx: number;
  qcount: number;
  closed: boolean;
  recvq: Gid[];
  sendq: { g: Gid; v: string }[];
  gs: Record<Gid, G>;
  nextOrder: number;
  seq: number;
  log: Ev[];
  stats: Stats;
  /** What the last operation touched, for highlighting. */
  touched: { slots: number[]; gs: Gid[] };
  guess: Guess | null;
  done: ChallengeId[];
  /** A panic happened: in a real program it ends the process unless recovered. */
  crashed: boolean;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "send"; g: Gid }
  | { type: "recv"; g: Gid }
  | { type: "close" }
  | { type: "setCap"; cap: number }
  | { type: "reset" };

const LOG_MAX = 6;

function goroutines(): Record<Gid, G> {
  const out = {} as Record<Gid, G>;
  for (const id of ALL) out[id] = { id, role: (SENDERS as readonly string[]).includes(id) ? "send" : "recv", status: "running", got: null, ok: null, holding: null };
  return out;
}

function channel(cap: number) {
  return { cap, buf: Array<string | null>(cap).fill(null), sendx: 0, recvx: 0, qcount: 0, closed: false, recvq: [] as Gid[], sendq: [] as { g: Gid; v: string }[] };
}

/** The start: an unbuffered channel, and R1 already parked on it, waiting for an order. */
export function init(): State {
  const gs = goroutines();
  gs.R1.status = "parked";
  return {
    ...channel(0),
    recvq: ["R1"],
    gs,
    nextOrder: 101,
    seq: 1,
    log: [{ id: 1, kind: "park", ok: true, path: ["R1", "lock", "nothing to take", "recvq += R1", "gopark"], text: "R1 ran v := <-ch first. Nothing was there, so it parked on recvq." }],
    stats: zero(),
    touched: { slots: [], gs: ["R1"] },
    guess: null,
    done: [],
    crashed: false,
  };
}

/* ---------------- helpers ---------------- */

function clone(s: State): State {
  const gs = {} as Record<Gid, G>;
  for (const id of ALL) gs[id] = { ...s.gs[id] };
  return { ...s, buf: [...s.buf], recvq: [...s.recvq], sendq: s.sendq.map((x) => ({ ...x })), gs, stats: { ...s.stats }, done: [...s.done], touched: { slots: [], gs: [] } };
}

function push(s: State, e: Omit<Ev, "id">) {
  s.seq++;
  s.log = [{ ...e, id: s.seq }, ...s.log].slice(0, LOG_MAX);
}

function achieve(s: State, c: ChallengeId) {
  if (!s.done.includes(c)) s.done.push(c);
}

const show = (v: string) => (v === "" ? "zero value" : v);

/* ---------------- the runtime's paths ---------------- */

/** chansend: closed? -> waiting receiver? -> free slot? -> park. */
function send(s: State, g: Gid) {
  const v = `#${s.nextOrder++}`;
  s.stats.sends++;
  s.stats.locks++;
  s.touched.gs.push(g);
  if (s.closed) {
    s.gs[g].status = "panicked";
    s.stats.panics++;
    s.crashed = true;
    push(s, { kind: "panic", ok: false, path: [g, "lock", "closed = 1", "panic"], text: `${g} sent ${v} on a closed channel: panic. Unrecovered, it ends the whole process.` });
    return;
  }
  const r = s.recvq.shift();
  if (r) {
    s.gs[r] = { ...s.gs[r], status: "running", got: v, ok: true };
    s.stats.handoffs++;
    s.stats.wakes++;
    s.touched.gs.push(r);
    if (s.cap > 0) achieve(s, "skipBuffer");
    push(s, {
      kind: "handoff", ok: true, path: [g, "lock", `recvq: ${r}`, `copy ${v} → ${r}'s stack`, `goready(${r})`],
      text: `${r} was parked waiting, so ${v} went straight from ${g}'s stack to ${r}'s. The buffer was never touched. ${g} did not wait.`,
    });
    return;
  }
  if (s.qcount < s.cap) {
    const i = s.sendx;
    s.buf[i] = v;
    s.sendx = (s.sendx + 1) % s.cap;
    s.qcount++;
    s.stats.buffered++;
    s.touched.slots.push(i);
    push(s, { kind: "buffer", ok: true, path: [g, "lock", "recvq empty", `buf[${i}] ← ${v}`, "unlock"], text: `No receiver was waiting and slot ${i} was free. ${v} was copied into the buffer and ${g} carried on.` });
    return;
  }
  s.sendq.push({ g, v });
  s.gs[g] = { ...s.gs[g], status: "parked", holding: v };
  s.stats.parks++;
  if (s.cap > 0) achieve(s, "parkSender");
  push(s, {
    kind: "park", ok: false, path: [g, "lock", s.cap === 0 ? "no receiver" : "buf full", `sendq += ${g}`, "gopark"],
    text: s.cap === 0
      ? `Unbuffered, and no receiver waiting. ${g} parked on sendq, still holding ${v}, until a receiver arrives.`
      : `All ${s.cap} slots are full. ${g} parked on sendq, still holding ${v}, until a receiver frees a slot.`,
  });
}

/** chanrecv: closed and empty? -> waiting sender? -> buffered value? -> park. */
function recv(s: State, g: Gid) {
  s.stats.recvs++;
  s.stats.locks++;
  s.touched.gs.push(g);
  if (s.closed && s.qcount === 0) {
    s.gs[g] = { ...s.gs[g], got: "", ok: false };
    s.stats.zeroReads++;
    push(s, { kind: "zero", ok: true, path: [g, "lock", "closed and empty", "zero value, ok=false"], text: `The channel is closed and drained. ${g} got the zero value at once, with ok == false. A range loop would end here.` });
    return;
  }
  const w = s.sendq.shift();
  if (w) {
    s.gs[w.g] = { ...s.gs[w.g], status: "running", holding: null };
    s.stats.wakes++;
    s.touched.gs.push(w.g);
    if (s.cap === 0) {
      s.gs[g] = { ...s.gs[g], got: w.v, ok: true };
      s.stats.handoffs++;
      push(s, { kind: "handoff", ok: true, path: [g, "lock", `sendq: ${w.g}`, `copy ${w.v} ← ${w.g}'s stack`, `goready(${w.g})`], text: `${w.g} was parked holding ${w.v}. ${g} copied it straight off ${w.g}'s stack and woke ${w.g}. No buffer involved.` });
      return;
    }
    // Buffer is full: take the head, put the parked sender's value in the slot just freed.
    const i = s.recvx;
    const head = s.buf[i]!;
    s.gs[g] = { ...s.gs[g], got: head, ok: true };
    s.buf[i] = w.v;
    s.recvx = (s.recvx + 1) % s.cap;
    s.sendx = s.recvx;
    s.stats.buffered++;
    s.touched.slots.push(i);
    achieve(s, "refill");
    push(s, {
      kind: "refill", ok: true, path: [g, "lock", `take buf[${i}] = ${head}`, `buf[${i}] ← ${w.v} from ${w.g}`, `goready(${w.g})`],
      text: `${g} took ${head}, the oldest value. ${w.g}'s parked ${w.v} went into the same slot, so the order is kept, and ${w.g} woke up. The buffer is still full.`,
    });
    return;
  }
  if (s.qcount > 0) {
    const i = s.recvx;
    const v = s.buf[i]!;
    s.buf[i] = null;
    s.recvx = (s.recvx + 1) % s.cap;
    s.qcount--;
    s.gs[g] = { ...s.gs[g], got: v, ok: true };
    s.touched.slots.push(i);
    push(s, { kind: "take", ok: true, path: [g, "lock", `take buf[${i}]`, `${v} → ${g}`, "unlock"], text: `${g} took ${v} from slot ${i}${s.closed ? ". The channel is closed, but values already buffered are still delivered" : ""}.` });
    return;
  }
  s.recvq.push(g);
  s.gs[g] = { ...s.gs[g], status: "parked" };
  s.stats.parks++;
  push(s, { kind: "park", ok: false, path: [g, "lock", "nothing to take", `recvq += ${g}`, "gopark"], text: `Nothing buffered and no sender waiting. ${g} parked on recvq.` });
}

/** closechan: mark closed, wake every receiver with the zero value, wake every sender to panic. */
function close(s: State) {
  s.stats.locks++;
  if (s.closed) {
    s.stats.panics++;
    s.crashed = true;
    push(s, { kind: "closeTwice", ok: false, path: ["close(ch)", "lock", "closed = 1 already", "panic"], text: "close of closed channel: panic. Only one goroutine, the last sender, should ever close a channel." });
    return;
  }
  s.closed = true;
  const rs = s.recvq.splice(0);
  const ws = s.sendq.splice(0);
  for (const r of rs) {
    s.gs[r] = { ...s.gs[r], status: "running", got: "", ok: false };
    s.stats.wakes++;
    s.stats.zeroReads++;
    s.touched.gs.push(r);
  }
  for (const w of ws) {
    s.gs[w.g] = { ...s.gs[w.g], status: "panicked", holding: w.v };
    s.stats.wakes++;
    s.stats.panics++;
    s.touched.gs.push(w.g);
  }
  if (ws.length) s.crashed = true;
  if (rs.length || ws.length) achieve(s, "closeWaiters");
  const parts: string[] = [];
  if (rs.length) parts.push(`${rs.join(" and ")} woke with the zero value and ok == false`);
  if (ws.length) parts.push(`${ws.map((w) => w.g).join(" and ")} woke and panicked: send on closed channel`);
  if (s.qcount) parts.push(`the ${s.qcount} buffered value${s.qcount > 1 ? "s are" : " is"} still there for receivers`);
  push(s, {
    kind: "close", ok: ws.length === 0, path: ["close(ch)", "lock", "closed = 1", `wake ${rs.length} receiver${rs.length === 1 ? "" : "s"}`, `wake ${ws.length} sender${ws.length === 1 ? "" : "s"}`],
    text: parts.length ? `Closed. ${parts.join("; ")}.` : "Closed. Nobody was parked. Later receives drain the buffer, then return the zero value; later sends panic.",
  });
}

/* ---------------- step ---------------- */

export function canAct(s: State, g: Gid): boolean {
  return s.gs[g].status === "running";
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.stats.sends > 0 ? st : { ...st, guess: a.guess };
    case "send": {
      if (st.gs[a.g].role !== "send" || !canAct(st, a.g)) return st;
      const s = clone(st);
      send(s, a.g);
      return s;
    }
    case "recv": {
      if (st.gs[a.g].role !== "recv" || !canAct(st, a.g)) return st;
      const s = clone(st);
      recv(s, a.g);
      return s;
    }
    case "close": {
      const s = clone(st);
      close(s);
      return s;
    }
    case "setCap": {
      if (!(CAPS as readonly number[]).includes(a.cap)) return st;
      // A new channel: make(chan Order, cap). Goroutines start fresh; the session's numbers stay.
      const s = clone(st);
      Object.assign(s, channel(a.cap));
      s.gs = goroutines();
      s.crashed = false;
      push(s, { kind: "buffer", ok: true, path: [`make(chan Order, ${a.cap})`], text: a.cap === 0 ? "A new unbuffered channel. Every send needs a receiver at the same moment." : `A new channel with ${a.cap} slot${a.cap > 1 ? "s" : ""}. Nobody is parked.` });
      return s;
    }
  }
}

/** The predict question is about the starting state: answered once the first send happens. */
export const ANSWER: Guess = "direct";
