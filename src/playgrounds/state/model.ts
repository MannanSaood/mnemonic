// State playground: one order, two implementations, the same stream of events.
//
// After this, the reader can answer: why does an order built from boolean flags accept events
// it should refuse, and how does giving each lifecycle state its own object make every
// unlisted event a rejection by default?
//
// The flag order is the lesson's "before" code: four booleans and one guard per method. The
// state order is the "after" code: the current state object decides which events it accepts.
// Every event goes to both. The reader tries to break them (ship a refunded order, refund twice,
// charge a cancelled order), replays webhooks, and runs a stress test of random event streams.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const EVENTS = ["pay", "ship", "deliver", "cancel"] as const;
export type Ev = (typeof EVENTS)[number];
export const LIFECYCLE = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
export type Life = (typeof LIFECYCLE)[number];
export const TOTAL = 80;

/** The legal transitions: the whole state machine, as the state design encodes it. */
export const TABLE: Record<Life, Partial<Record<Ev, Life>>> = {
  pending: { pay: "paid", cancel: "cancelled" },
  paid: { ship: "shipped", cancel: "cancelled" },
  shipped: { deliver: "delivered" },
  delivered: {},
  cancelled: {},
};

export interface Flags { paid: boolean; shipped: boolean; delivered: boolean; cancelled: boolean }
export const FLAG_NAMES = ["paid", "shipped", "delivered", "cancelled"] as const;
export interface Ledger { charged: number; refunded: number; parcels: number }

/** The flag combinations that mean something. The other 10 of 16 are nonsense. */
export function lifeOf(f: Flags): Life | null {
  const k = comboKey(f);
  return ({ "0000": "pending", "1000": "paid", "1100": "shipped", "1110": "delivered", "0001": "cancelled", "1001": "cancelled" } as Record<string, Life>)[k] ?? null;
}
export const comboKey = (f: Flags) => FLAG_NAMES.map((n) => (f[n] ? "1" : "0")).join("");

export type Bug = "ship-cancelled" | "refund-twice" | "charge-cancelled" | "ship-twice";
export const BUGS: { id: Bug; title: string; hint: string }[] = [
  { id: "ship-cancelled", title: "Ship an order that was refunded", hint: "Pay, Cancel, Ship" },
  { id: "refund-twice", title: "Refund the same order twice", hint: "Pay, Cancel, then resend Cancel" },
  { id: "charge-cancelled", title: "Charge a cancelled order", hint: "Cancel, then Pay" },
  { id: "ship-twice", title: "Send two parcels for one order", hint: "Pay, Ship, then resend Ship" },
];

export interface Outcome { ok: boolean; text: string; path: string[] }

export interface FlagSide { flags: Flags; ledger: Ledger; visited: string[]; badAccepts: number }
export interface MachineSide { life: Life; ledger: Ledger; rejected: number }

export interface Entry { id: number; ev: Ev; resent: boolean; flag: Outcome; machine: Outcome; bug: Bug | null }

export interface Stress { runs: number; orders: number; events: number; flagBad: number; machineBad: number; machineRejected: number }

export interface State {
  seq: number;
  flag: FlagSide;
  machine: MachineSide;
  log: Entry[];
  sent: number;
  last: Ev | null;
  found: Bug[];
  stress: Stress | null;
}

export type Action =
  | { type: "fire"; ev: Ev }
  | { type: "resend" }
  | { type: "newOrder" }
  | { type: "stress" }
  | { type: "reset" };

const noLedger = (): Ledger => ({ charged: 0, refunded: 0, parcels: 0 });
const freshFlags = (): Flags => ({ paid: false, shipped: false, delivered: false, cancelled: false });

function freshOrder() {
  return {
    flag: { flags: freshFlags(), ledger: noLedger(), visited: ["0000"], badAccepts: 0 } as FlagSide,
    machine: { life: "pending" as Life, ledger: noLedger(), rejected: 0 } as MachineSide,
    log: [] as Entry[],
    sent: 0,
    last: null as Ev | null,
  };
}

export function init(): State {
  return { seq: 0, ...freshOrder(), found: [], stress: null };
}

/* ---------------- the flag order: the lesson's "before" code ---------------- */

/** Runs one method of the flag order exactly as written. Returns the new side and what happened. */
export function flagStep(s: FlagSide, ev: Ev): { s: FlagSide; out: Outcome; bug: Bug | null } {
  const f = { ...s.flags }, l = { ...s.ledger };
  const before = lifeOf(f);
  const legal = before !== null && TABLE[before][ev] !== undefined;
  let out: Outcome;
  let bug: Bug | null = null;
  switch (ev) {
    case "pay":
      if (f.paid) { out = { ok: false, text: "Rejected: already paid.", path: ["Pay()", "if paid", "error"] }; break; }
      f.paid = true; l.charged += TOTAL;
      if (f.cancelled) bug = "charge-cancelled";
      out = { ok: true, text: `Charged $${TOTAL}.`, path: ["Pay()", "if paid: no", "paid = true", `charge $${TOTAL}`] };
      break;
    case "ship":
      if (!f.paid) { out = { ok: false, text: "Rejected: not paid.", path: ["Ship()", "if !paid", "error"] }; break; }
      if (f.cancelled) bug = "ship-cancelled";
      else if (f.shipped) bug = "ship-twice";
      f.shipped = true; l.parcels += 1;
      out = { ok: true, text: `Parcel #${l.parcels} left the warehouse.`, path: ["Ship()", "if !paid: no", "shipped = true", `parcel #${l.parcels}`] };
      break;
    case "deliver":
      if (!f.shipped) { out = { ok: false, text: "Rejected: not shipped.", path: ["Deliver()", "if !shipped", "error"] }; break; }
      f.delivered = true;
      out = { ok: true, text: "Marked delivered.", path: ["Deliver()", "if !shipped: no", "delivered = true"] };
      break;
    case "cancel":
      if (f.shipped) { out = { ok: false, text: "Rejected: already shipped.", path: ["Cancel()", "if shipped", "error"] }; break; }
      if (f.cancelled && f.paid) bug = "refund-twice";
      f.cancelled = true;
      if (f.paid) { l.refunded += TOTAL; out = { ok: true, text: `Cancelled and refunded $${TOTAL}.`, path: ["Cancel()", "if shipped: no", "cancelled = true", `refund $${TOTAL}`] }; }
      else out = { ok: true, text: "Cancelled. Nothing to refund.", path: ["Cancel()", "if shipped: no", "cancelled = true"] };
      break;
  }
  const key = comboKey(f);
  const accepted = out.ok;
  return {
    s: {
      flags: f, ledger: l,
      visited: s.visited.includes(key) ? s.visited : [...s.visited, key],
      badAccepts: s.badAccepts + (accepted && !legal ? 1 : 0),
    },
    out: accepted && !legal ? { ...out, ok: false, text: out.text + " An order in this state should have refused." } : out,
    bug: accepted ? bug : null,
  };
}

/* ---------------- the state order: the lesson's "after" code ---------------- */

const STATE_NAME: Record<Life, string> = { pending: "Pending", paid: "Paid", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };
export const stateName = (l: Life) => STATE_NAME[l];

export function machineStep(s: MachineSide, ev: Ev): { s: MachineSide; out: Outcome } {
  const next = TABLE[s.life][ev];
  const name = STATE_NAME[s.life];
  const method = ev[0].toUpperCase() + ev.slice(1);
  if (!next) return { s: { ...s, rejected: s.rejected + 1 }, out: { ok: true, text: `Rejected: ${name} has no ${method}. Nothing changed.`, path: [`${method}()`, `${name}.${method}`, "default: reject"] } };
  const l = { ...s.ledger };
  let effect = "";
  if (ev === "pay") { l.charged += TOTAL; effect = `charge $${TOTAL}`; }
  if (ev === "ship") { l.parcels += 1; effect = `parcel #${l.parcels}`; }
  if (ev === "cancel" && s.life === "paid") { l.refunded += TOTAL; effect = `refund $${TOTAL}`; }
  const text = { pay: `Charged $${TOTAL}.`, ship: `Parcel #${l.parcels} left the warehouse.`, deliver: "Marked delivered.", cancel: effect ? `Cancelled and refunded $${TOTAL}.` : "Cancelled. Nothing to refund." }[ev];
  return {
    s: { ...s, life: next, ledger: l },
    out: { ok: true, text, path: [`${method}()`, `${name}.${method}`, ...(effect ? [effect] : []), `→ ${STATE_NAME[next]}`] },
  };
}

/* ---------------- checking the books ---------------- */

/** What is wrong with an order's money and goods, or null if the books are consistent. */
export function booksProblem(l: Ledger, cancelled: boolean): string | null {
  const net = l.charged - l.refunded;
  if (l.refunded > l.charged) return `refunded $${l.refunded} on $${l.charged} charged`;
  if (l.charged > TOTAL) return `charged $${l.charged} for an $${TOTAL} order`;
  if (l.parcels > 1) return `${l.parcels} parcels for one order`;
  if (l.parcels === 1 && net === 0) return "a parcel shipped that nobody paid for";
  if (cancelled && net > 0) return `kept $${net} for a cancelled order`;
  return null;
}
export const flagProblem = (s: FlagSide) => booksProblem(s.ledger, s.flags.cancelled) ?? (lifeOf(s.flags) === null ? "flags in a combination no order can be in" : null);
export const machineProblem = (s: MachineSide) => booksProblem(s.ledger, s.life === "cancelled");

/* ---------------- stress test ---------------- */

function rand(seed: number) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STRESS_ORDERS = 200, STRESS_EVENTS = 4;

/**
 * Real event streams: payment webhooks, warehouse scanners and support agents act on the same
 * order without coordinating, and webhooks are delivered at least once, so an event is sometimes
 * repeated. Each order gets a mostly sensible stream with some of that noise.
 */
export function stressRun(run: number): Stress {
  const r = rand(4242 + run * 7919);
  let flagBad = 0, machineBad = 0, machineRejected = 0, events = 0;
  for (let o = 0; o < STRESS_ORDERS; o++) {
    let fs = freshOrder().flag, ms = freshOrder().machine;
    let prev: Ev | null = null;
    let next = 0; // position on the happy path pay, ship, deliver
    for (let i = 0; i < STRESS_EVENTS; i++) {
      const x = r();
      let ev: Ev;
      if (prev && x < 0.08) ev = prev;                                  // webhook delivered twice
      else if (x < 0.16) ev = "cancel";                                  // customer or support cancels
      else if (x < 0.22 || next > 2) ev = EVENTS[Math.floor(r() * 4)];   // a late or stray event
      else ev = (["pay", "ship", "deliver"] as const)[next++];
      fs = flagStep(fs, ev).s;
      const m = machineStep(ms, ev);
      ms = m.s;
      prev = ev;
      events++;
    }
    machineRejected += ms.rejected;
    if (flagProblem(fs)) flagBad++;
    if (machineProblem(ms)) machineBad++;
  }
  return { runs: run + 1, orders: STRESS_ORDERS, events, flagBad, machineBad, machineRejected };
}

/* ---------------- step ---------------- */

function fire(st: State, ev: Ev, resent: boolean): State {
  const f = flagStep(st.flag, ev);
  const m = machineStep(st.machine, ev);
  const id = st.seq + 1;
  const entry: Entry = { id, ev, resent, flag: f.out, machine: m.out, bug: f.bug };
  return {
    ...st,
    seq: id,
    flag: f.s,
    machine: m.s,
    log: [entry, ...st.log].slice(0, 12),
    sent: st.sent + 1,
    last: ev,
    found: f.bug && !st.found.includes(f.bug) ? [...st.found, f.bug] : st.found,
  };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "fire":
      return fire(st, a.ev, false);
    case "resend":
      return st.last ? fire(st, st.last, true) : st;
    case "newOrder":
      return { ...st, ...freshOrder() };
    case "stress":
      return { ...st, stress: stressRun(st.stress ? st.stress.runs : 0) };
  }
}
