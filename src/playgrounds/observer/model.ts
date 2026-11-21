// Observer playground: one order service publishes "order placed" to its subscribers. Every
// order runs through two deliveries side by side: the classic in-process loop (the subject calls
// each listener in turn) and the same subscribers behind a queue (the subject only records the
// event, each subscriber reads it at its own pace).
//
// After this, the reader can answer: "My subscribers are decoupled from the order service, so
// why did a bug in the email listener fail the customer's checkout?"
// Core insight: Observer removes what the subject KNOWS about its subscribers, not what they
// COST it. With an in-process loop, every listener's time and every exception lands on the
// publisher's request, and a listener nobody unsubscribed keeps being called.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type SubId = "email" | "inventory" | "analytics" | "fraud";
export type Mode = "ok" | "slow" | "throws";
export type Design = "inproc" | "queue";

export const SUBS: SubId[] = ["email", "inventory", "analytics", "fraud"];
export const LABEL: Record<SubId, string> = { email: "Email", inventory: "Inventory", analytics: "Analytics", fraud: "Fraud" };
/** What each listener does with the event, in a few words. */
export const JOB: Record<SubId, string> = {
  email: "sends the confirmation",
  inventory: "reserves the stock",
  analytics: "records the sale",
  fraud: "scores the order",
};
/** Normal handling time in ms. */
export const MS: Record<SubId, number> = { email: 120, inventory: 30, analytics: 10, fraud: 80 };
export const SLOW_MS = 2500;
export const SAVE_MS = 20;
export const OUTBOX_MS = 5;
/** The gateway in front of checkout gives up after this long, and the customer sees an error. */
export const TIMEOUT_MS = 2000;
/** A live-orders panel in an admin tab redraws a table on every event. */
export const PANEL_MS = 6;

/** A subscription: one of the four services, or an admin tab's live-orders panel. */
export interface Subscription { key: string; sub?: SubId; panel?: number }

export interface Panel { n: number; open: boolean; subscribed: boolean }

export type HopResult = "ok" | "slow" | "threw" | "skipped" | "zombie" | "queued" | "behind" | "retrying" | "piling";
export interface Hop { key: string; label: string; result: HopResult; ms: number }

export interface Trace {
  order: number;
  hops: Hop[];
  /** How long the customer waited for the checkout response. */
  ms: number;
  /** What the customer saw. */
  customer: "ok" | "error" | "timeout";
}

export interface InprocTally { errors: number; slowest: number; lost: number; zombieCalls: number }
export interface QueueTally { slowest: number; delivered: number; caughtUp: number; abandoned: number }

export interface State {
  subs: Subscription[];
  modes: Record<SubId, Mode>;
  panels: Panel[];
  /** Break-it switch: when false, closing an admin tab leaves its listener subscribed. */
  unsubscribeOnClose: boolean;
  nextOrder: number;
  orders: number;
  inproc: { last: Trace | null; tally: InprocTally };
  queue: {
    last: Trace | null;
    tally: QueueTally;
    /** Messages waiting per subscriber: retries for a failing one, backlog for a slow one. */
    waiting: Record<string, number>;
  };
  prediction: string | null;
  /** Guided-challenge flags. */
  sawThrow: boolean;
  sawSlowFraud: boolean;
  recovered: boolean;
}

export type Action =
  | { type: "toggleSub"; sub: SubId }
  | { type: "setMode"; sub: SubId; mode: Mode }
  | { type: "openPanel" }
  | { type: "closePanel"; n: number }
  | { type: "setUnsubscribeOnClose"; on: boolean }
  | { type: "place"; count?: number }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    subs: (["email", "inventory", "analytics"] as SubId[]).map((s) => ({ key: s, sub: s })),
    modes: { email: "ok", inventory: "ok", analytics: "ok", fraud: "ok" },
    panels: [],
    unsubscribeOnClose: true,
    nextOrder: 1041,
    orders: 0,
    inproc: { last: null, tally: { errors: 0, slowest: 0, lost: 0, zombieCalls: 0 } },
    queue: { last: null, tally: { slowest: 0, delivered: 0, caughtUp: 0, abandoned: 0 }, waiting: {} },
    prediction: null,
    sawThrow: false,
    sawSlowFraud: false,
    recovered: false,
  };
}

export const subscribed = (s: State, sub: SubId) => s.subs.some((x) => x.sub === sub);
export const panelLabel = (n: number) => `Admin tab ${n}`;
const labelOf = (x: Subscription) => (x.sub ? LABEL[x.sub] : panelLabel(x.panel!));
const panelOf = (s: State, x: Subscription) => s.panels.find((p) => p.n === x.panel);

/* ---------------- one order, two deliveries ---------------- */

/** The classic loop: for each listener, call it, in subscription order, inside the request. */
function deliverInproc(s: State, order: number): { trace: Trace; tally: InprocTally; threw: boolean } {
  const tally = { ...s.inproc.tally };
  const hops: Hop[] = [];
  let ms = SAVE_MS;
  let threw = false;
  for (const x of s.subs) {
    const label = labelOf(x);
    if (threw) {
      hops.push({ key: x.key, label, result: "skipped", ms: 0 });
      if (x.sub) tally.lost++;
      continue;
    }
    if (x.panel !== undefined) {
      const p = panelOf(s, x);
      const zombie = !p?.open;
      ms += PANEL_MS;
      if (zombie) tally.zombieCalls++;
      hops.push({ key: x.key, label, result: zombie ? "zombie" : "ok", ms: PANEL_MS });
      continue;
    }
    const sub = x.sub!;
    const mode = s.modes[sub];
    if (mode === "throws") {
      threw = true;
      tally.lost++;
      hops.push({ key: x.key, label, result: "threw", ms: 0 });
    } else {
      const t = mode === "slow" ? SLOW_MS : MS[sub];
      ms += t;
      hops.push({ key: x.key, label, result: mode === "slow" ? "slow" : "ok", ms: t });
    }
  }
  const customer: Trace["customer"] = threw ? "error" : ms > TIMEOUT_MS ? "timeout" : "ok";
  if (customer !== "ok") tally.errors++;
  tally.slowest = Math.max(tally.slowest, ms);
  return { trace: { order, hops, ms, customer }, tally, threw };
}

/** The same subscribers behind a queue: the request only writes the event; consumers catch up. */
function deliverQueue(s: State, order: number): { trace: Trace; tally: QueueTally; waiting: Record<string, number> } {
  const tally = { ...s.queue.tally };
  const waiting = { ...s.queue.waiting };
  const hops: Hop[] = [];
  for (const x of s.subs) {
    const label = labelOf(x);
    if (x.panel !== undefined) {
      const p = panelOf(s, x);
      if (p?.open) {
        tally.delivered++;
        hops.push({ key: x.key, label, result: "ok", ms: PANEL_MS });
      } else {
        // Nobody reads this queue any more, and nobody deleted it.
        waiting[x.key] = (waiting[x.key] ?? 0) + 1;
        tally.abandoned++;
        hops.push({ key: x.key, label, result: "piling", ms: 0 });
      }
      continue;
    }
    const mode = s.modes[x.sub!];
    if (mode === "ok") {
      tally.delivered++;
      hops.push({ key: x.key, label, result: "ok", ms: MS[x.sub!] });
    } else {
      waiting[x.key] = (waiting[x.key] ?? 0) + 1;
      hops.push({ key: x.key, label, result: mode === "slow" ? "behind" : "retrying", ms: 0 });
    }
  }
  const ms = SAVE_MS + OUTBOX_MS;
  tally.slowest = Math.max(tally.slowest, ms);
  return { trace: { order, hops, ms, customer: "ok" }, tally, waiting };
}

function placeOne(s: State): State {
  const order = s.nextOrder;
  const a = deliverInproc(s, order);
  const b = deliverQueue(s, order);
  return {
    ...s,
    nextOrder: order + 1,
    orders: s.orders + 1,
    inproc: { last: a.trace, tally: a.tally },
    queue: { last: b.trace, tally: b.tally, waiting: b.waiting },
    sawThrow: s.sawThrow || a.threw,
    sawSlowFraud: s.sawSlowFraud || (subscribed(s, "fraud") && s.modes.fraud === "slow"),
  };
}

/** Messages still waiting in the queue design (retries, backlog and abandoned queues). */
export const waitingTotal = (s: State) => Object.values(s.queue.waiting).reduce((a, b) => a + b, 0);
/** Waiting for a live consumer: they will be delivered once it recovers. */
export const waitingLive = (s: State) =>
  Object.entries(s.queue.waiting).filter(([k]) => !k.startsWith("panel")).reduce((a, [, v]) => a + v, 0);

/** Listeners on the subject that belong to a closed tab. */
export const zombies = (s: State) => s.panels.filter((p) => !p.open && p.subscribed).length;

/* ---------------- step ---------------- */

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };

    case "toggleSub": {
      if (subscribed(s, a.sub)) {
        const waiting = { ...s.queue.waiting };
        delete waiting[a.sub];
        return { ...s, subs: s.subs.filter((x) => x.sub !== a.sub), queue: { ...s.queue, waiting } };
      }
      // A new subscriber goes to the end: it is notified last.
      return { ...s, subs: [...s.subs, { key: a.sub, sub: a.sub }] };
    }

    case "setMode": {
      const next = { ...s, modes: { ...s.modes, [a.sub]: a.mode } };
      // In the queue design a consumer that works again drains what was waiting for it.
      const pending = s.queue.waiting[a.sub] ?? 0;
      if (a.mode === "ok" && pending > 0) {
        const waiting = { ...s.queue.waiting };
        delete waiting[a.sub];
        return {
          ...next,
          recovered: true,
          queue: { ...s.queue, waiting, tally: { ...s.queue.tally, delivered: s.queue.tally.delivered + pending, caughtUp: s.queue.tally.caughtUp + pending } },
        };
      }
      return next;
    }

    case "openPanel": {
      const n = s.panels.length + 1;
      return {
        ...s,
        panels: [...s.panels, { n, open: true, subscribed: true }],
        subs: [...s.subs, { key: `panel${n}`, panel: n }],
      };
    }

    case "closePanel": {
      const p = s.panels.find((x) => x.n === a.n);
      if (!p || !p.open) return s;
      const unsub = s.unsubscribeOnClose;
      const panels = s.panels.map((x) => (x.n === a.n ? { ...x, open: false, subscribed: !unsub } : x));
      return { ...s, panels, subs: unsub ? s.subs.filter((x) => x.panel !== a.n) : s.subs };
    }

    case "setUnsubscribeOnClose":
      return { ...s, unsubscribeOnClose: a.on };

    case "place": {
      let next = s;
      for (let i = 0; i < Math.max(1, Math.min(a.count ?? 1, 20)); i++) next = placeOne(next);
      return next;
    }
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "throw", text: "Make the email listener throw, then place an order." },
  { id: "slow", text: "Subscribe Fraud, make it slow, and place an order. Compare the two checkout times." },
  { id: "zombie", text: "Switch off unsubscribe-on-close, open and close two admin tabs, then place five orders." },
  { id: "recover", text: "Set the broken listener back to OK. Which design gets its missed messages back?" },
] as const;

export function challengeDone(s: State, id: (typeof CHALLENGES)[number]["id"]): boolean {
  switch (id) {
    case "throw": return s.sawThrow;
    case "slow": return s.sawSlowFraud;
    case "zombie": return s.inproc.tally.zombieCalls >= 10;
    case "recover": return s.recovered;
  }
}
