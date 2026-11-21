// Purpose: after this, the reader can answer: "When a step of an order fails halfway across four
// services, which earlier steps must be undone, who knows that they must be, and what does the
// rest of the system see until they are?"
// Core insight: a saga replaces one transaction with local transactions plus compensations. A
// failure late in the workflow means undoing every earlier step, in reverse. Until that finishes,
// other readers see half-done states (no isolation). Orchestration puts the knowledge of the flow,
// and its state, in one place that must be durable; choreography spreads it across services that
// must each listen for the right failure events.
//
// An order workflow across Orders, Inventory, Payments and Shipping, then an email. The reader
// picks orchestration or choreography, injects a failure at one step, turns compensations on or
// off, and breaks it (crash the orchestrator with or without a durable saga log, or let Inventory
// miss the failure event). Then they step through the messages and watch each service's state.
//
// Plain state + pure functions, so it can be tested without a browser.

export type Style = "orch" | "chor";
export type Svc = "orch" | "orders" | "inventory" | "payments" | "shipping" | "email";
export const LANES: Record<Style, Svc[]> = {
  orch: ["orch", "orders", "inventory", "payments", "shipping", "email"],
  chor: ["orders", "inventory", "payments", "shipping", "email"],
};
export const SVC_LABEL: Record<Svc, string> = {
  orch: "Orchestrator", orders: "Orders", inventory: "Inventory", payments: "Payments", shipping: "Shipping", email: "Email",
};

/** The three steps that can fail, in workflow order. 0 means nothing fails. */
export type FailAt = 0 | 1 | 2 | 3;
export const STEP_SVC: Record<1 | 2 | 3, Svc> = { 1: "inventory", 2: "payments", 3: "shipping" };
export const FAIL_REASON: Record<1 | 2 | 3, string> = {
  1: "out of stock",
  2: "card declined",
  3: "no courier for this postcode",
};
export const AMOUNT = 85_00;

export interface World {
  order: "none" | "pending" | "approved" | "rejected";
  reserved: number;
  charged: number;
  refunded: number;
  courier: "none" | "booked" | "cancelled";
  email: "none" | "confirmed" | "cancelled";
}
export const EMPTY: World = { order: "none", reserved: 0, charged: 0, refunded: 0, courier: "none", email: "none" };

export type Kind = "cmd" | "reply" | "event" | "comp" | "fail" | "crash" | "note" | "ignored";
export interface Msg {
  from: Svc;
  to: Svc;
  label: string;
  kind: Kind;
  effect?: Partial<World>;
  /** this message is a compensating action */
  compensation?: boolean;
}

export interface Config {
  style: Style;
  failAt: FailAt;
  compensate: boolean;
  /** orchestration: the orchestrator crashes right after hearing about the failure */
  crash: boolean;
  /** orchestration: the orchestrator writes each step to a durable saga log */
  durable: boolean;
  /** choreography: Inventory never subscribed to the payment and shipping failure events */
  deaf: boolean;
}

const FORWARD: Record<1 | 2 | 3, { cmd: string; done: string; effect: Partial<World> }> = {
  1: { cmd: "ReserveStock", done: "StockReserved", effect: { reserved: 1 } },
  2: { cmd: `Charge $${AMOUNT / 100}`, done: "PaymentCompleted", effect: { charged: AMOUNT } },
  3: { cmd: "BookCourier", done: "CourierBooked", effect: { courier: "booked" } },
};
const UNDO: Record<1 | 2 | 3, { cmd: string; done: string; effect: Partial<World> }> = {
  1: { cmd: "ReleaseStock", done: "StockReleased", effect: { reserved: 0 } },
  2: { cmd: `Refund $${AMOUNT / 100}`, done: "PaymentRefunded", effect: { refunded: AMOUNT } },
  3: { cmd: "CancelCourier", done: "CourierCancelled", effect: { courier: "cancelled" } },
};
const FAILED_EVENT: Record<1 | 2 | 3, string> = { 1: "StockUnavailable", 2: "PaymentFailed", 3: "CourierUnavailable" };

function orchestration(c: Config): Msg[] {
  const m: Msg[] = [
    { from: "orch", to: "orders", label: "CreateOrder", kind: "cmd", effect: { order: "pending" } },
    { from: "orders", to: "orch", label: "order 1042 pending", kind: "reply" },
  ];
  for (const i of [1, 2, 3] as const) {
    const svc = STEP_SVC[i];
    if (c.failAt === i) {
      m.push({ from: "orch", to: svc, label: FORWARD[i].cmd, kind: "cmd" });
      m.push({ from: svc, to: "orch", label: `failed: ${FAIL_REASON[i]}`, kind: "fail" });
      break;
    }
    m.push({ from: "orch", to: svc, label: FORWARD[i].cmd, kind: "cmd", effect: FORWARD[i].effect });
    m.push({ from: svc, to: "orch", label: "done", kind: "reply" });
  }
  if (c.failAt === 0) {
    m.push({ from: "orch", to: "orders", label: "ApproveOrder", kind: "cmd", effect: { order: "approved" } });
    m.push({ from: "orch", to: "email", label: "SendConfirmation", kind: "cmd", effect: { email: "confirmed" } });
    return m;
  }
  const f = c.failAt;
  if (c.crash) {
    m.push({ from: "orch", to: "orch", label: "orchestrator crashes", kind: "crash" });
    if (!c.durable) {
      m.push({ from: "orch", to: "orch", label: "restarts: no record of order 1042", kind: "note" });
      return m;
    }
    m.push({ from: "orch", to: "orch", label: `restarts: saga log says step ${f} failed`, kind: "note" });
  }
  if (c.compensate) {
    for (let j = f - 1; j >= 1; j--) {
      const k = j as 1 | 2 | 3;
      m.push({ from: "orch", to: STEP_SVC[k], label: UNDO[k].cmd, kind: "comp", effect: UNDO[k].effect, compensation: true });
      m.push({ from: STEP_SVC[k], to: "orch", label: "done", kind: "reply" });
    }
  }
  m.push({ from: "orch", to: "orders", label: "RejectOrder", kind: c.compensate ? "comp" : "cmd", effect: { order: "rejected" }, compensation: c.compensate });
  m.push({ from: "orch", to: "email", label: "SendCancellation", kind: "cmd", effect: { email: "cancelled" } });
  return m;
}

function choreography(c: Config): Msg[] {
  const m: Msg[] = [];
  // Orders creates the pending order and publishes OrderCreated; Inventory reacts.
  m.push({ from: "orders", to: "inventory", label: "OrderCreated", kind: "event", effect: { order: "pending" } });
  const chain: [1 | 2 | 3, Svc][] = [[1, "payments"], [2, "shipping"], [3, "orders"]];
  for (const [i, next] of chain) {
    const svc = STEP_SVC[i];
    if (c.failAt === i) {
      m.push({ from: svc, to: "orders", label: FAILED_EVENT[i], kind: "fail" });
      break;
    }
    // the service did its local transaction and publishes the result
    m[m.length - 1] = { ...m[m.length - 1], effect: { ...(m[m.length - 1].effect ?? {}), ...FORWARD[i].effect } };
    m.push({ from: svc, to: next, label: FORWARD[i].done, kind: "event" });
  }
  if (c.failAt === 0) {
    m[m.length - 1] = { ...m[m.length - 1], effect: { order: "approved" } };
    m.push({ from: "orders", to: "email", label: "OrderApproved", kind: "event", effect: { email: "confirmed" } });
    return m;
  }
  const f = c.failAt;
  // Orders always listens for the failure events and rejects the order.
  const reject: Msg = { from: "orders", to: "email", label: "OrderRejected", kind: "event", effect: { email: "cancelled" } };
  m[m.length - 1] = { ...m[m.length - 1], effect: { order: "rejected" }, compensation: c.compensate };
  if (c.compensate) {
    // Each earlier service listens for the failure of the step after it, undoes, and publishes.
    let trigger = FAILED_EVENT[f];
    for (let j = f - 1; j >= 1; j--) {
      const k = j as 1 | 2 | 3;
      const svc = STEP_SVC[k];
      const from = STEP_SVC[(k + 1) as 1 | 2 | 3];
      if (svc === "inventory" && c.deaf) {
        m.push({ from, to: svc, label: `${trigger}: not subscribed`, kind: "ignored" });
        break;
      }
      m.push({ from, to: svc, label: trigger, kind: "comp", effect: UNDO[k].effect, compensation: true });
      trigger = UNDO[k].done;
    }
  }
  m.push(reject);
  return m;
}

export function timeline(c: Config): Msg[] {
  return c.style === "orch" ? orchestration(c) : choreography(c);
}

/** The world after the first n messages. */
export function worldAt(msgs: Msg[], n: number): World {
  let w = { ...EMPTY };
  for (const m of msgs.slice(0, n)) if (m.effect) w = { ...w, ...m.effect };
  return w;
}

/** Effects left behind for an order that will never complete. */
export function leftovers(w: World): string[] {
  if (w.order === "approved") return [];
  const out: string[] = [];
  if (w.reserved) out.push("1 unit of stock held");
  if (w.charged - w.refunded > 0) out.push(`$${(w.charged - w.refunded) / 100} charged`);
  if (w.courier === "booked") out.push("a courier booked");
  if (w.order === "pending") out.push("the order stuck at pending");
  return out;
}

/** A half-done state another reader could see: the order is not final but some step took effect. */
export const halfDone = (w: World) =>
  w.order === "pending" && (w.reserved > 0 || w.charged - w.refunded > 0 || w.courier === "booked");

export interface Summary {
  messages: number;
  compensations: number;
  /** message steps during which the order was pending with partial effects visible */
  halfDoneSteps: number;
  end: World;
  leftovers: string[];
  /** where the workflow's state can be read from in one place */
  stateIn: string;
}
export function summarize(c: Config): Summary {
  const msgs = timeline(c);
  let half = 0;
  for (let i = 1; i <= msgs.length; i++) if (halfDone(worldAt(msgs, i))) half++;
  const end = worldAt(msgs, msgs.length);
  return {
    messages: msgs.filter((m) => m.kind !== "crash" && m.kind !== "note").length,
    compensations: msgs.filter((m) => m.compensation).length,
    halfDoneSteps: half,
    end,
    leftovers: leftovers(end),
    stateIn: c.style === "orch" ? (c.durable ? "the saga log" : "the orchestrator's memory") : "nowhere: ask four services",
  };
}

/* ---------------- state ---------------- */

export interface Finished { config: Config; leftovers: string[]; compensations: number }
export interface State {
  config: Config;
  cursor: number;
  finished: Finished[];
  predict: string | null;
}

export type Action =
  | { type: "style"; style: Style }
  | { type: "fail"; at: FailAt }
  | { type: "compensate"; on: boolean }
  | { type: "crash"; on: boolean }
  | { type: "durable"; on: boolean }
  | { type: "deaf"; on: boolean }
  | { type: "next" }
  | { type: "run" }
  | { type: "rewind" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    config: { style: "orch", failAt: 3, compensate: true, crash: false, durable: true, deaf: false },
    cursor: 0,
    finished: [],
    predict: null,
  };
}

export const PREDICT_ANSWER = "3";
export const predictRevealed = (s: State) =>
  s.finished.some((f) => f.config.failAt === 3 && f.config.compensate && !f.config.crash && !f.config.deaf);

function finish(s: State, cursor: number): State {
  const msgs = timeline(s.config);
  if (cursor < msgs.length || s.cursor >= msgs.length) return { ...s, cursor };
  const sum = summarize(s.config);
  return { ...s, cursor, finished: [...s.finished, { config: s.config, leftovers: sum.leftovers, compensations: sum.compensations }] };
}

export function step(s: State, a: Action): State {
  const cfg = (patch: Partial<Config>): State => ({ ...s, config: { ...s.config, ...patch }, cursor: 0 });
  switch (a.type) {
    case "reset": return init();
    case "style": return cfg({ style: a.style });
    case "fail": return cfg({ failAt: a.at });
    case "compensate": return cfg({ compensate: a.on });
    case "crash": return cfg({ crash: a.on });
    case "durable": return cfg({ durable: a.on });
    case "deaf": return cfg({ deaf: a.on });
    case "rewind": return { ...s, cursor: 0 };
    case "next": return finish(s, Math.min(s.cursor + 1, timeline(s.config).length));
    case "run": return finish(s, timeline(s.config).length);
    case "predict": return s.predict || predictRevealed(s) ? s : { ...s, predict: a.value };
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "noComp", text: "Decline the card with compensations off, and leave stock held for a rejected order." },
  { id: "clean", text: "Fail at shipping, the last step, and still end with nothing left behind." },
  { id: "crash", text: "Crash the orchestrator without a durable log and strand a customer's money." },
  { id: "deaf", text: "In choreography, let Inventory miss the failure event." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  return s.finished.some(({ config: c, leftovers: l }) => {
    switch (id) {
      case "noComp": return c.failAt === 2 && !c.compensate && l.includes("1 unit of stock held");
      case "clean": return c.failAt === 3 && l.length === 0;
      case "crash": return c.style === "orch" && c.crash && !c.durable && l.some((x) => x.endsWith("charged"));
      case "deaf": return c.style === "chor" && c.deaf && c.compensate && c.failAt >= 2 && l.includes("1 unit of stock held");
    }
  });
}
