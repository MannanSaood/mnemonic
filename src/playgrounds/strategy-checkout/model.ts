// Strategy playground: the same checkout built two ways, side by side, taking the same live
// traffic while the reader makes change requests in both.
//
// What the reader should come away with:
// 1. Adding a provider. In the branch design the change is spread over three places, and every
//    edit is its own deploy, so customers hit the half-done states in between. In the strategy
//    design it is one change: there is no half-done state.
// 2. Changing one provider. Fixing PayPal's refund call costs one edit in both designs. Strategy
//    makes adding and removing variants cheap; it does not make every change cheap.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Side = "branch" | "strategy";
export type Place = "pay" | "refund" | "config";
export const PROVIDERS = ["stripe", "paypal", "adyen", "klarna"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const NAME: Record<Provider, string> = { stripe: "Stripe", paypal: "PayPal", adyen: "Adyen", klarna: "Klarna" };
const START: Provider[] = ["stripe", "paypal", "adyen"];

/** Lines changed per edit (as in the lesson's Go code). */
export const LINES: Record<Place, number> = { pay: 2, refund: 2, config: 1 };

export interface Payment { id: number; provider: Provider; refunded: boolean }
export interface Event {
  id: number;
  kind: "pay" | "refund";
  provider: Provider;
  ok: boolean;
  /** The hops the call took; the last one is where it ended. */
  path: string[];
  /** What the customer experienced, in one sentence. */
  outcome: string;
}

export interface Tally { deploys: number; lines: number; places: string[]; files: number; lostSales: number; stuckRefunds: number }
const zero = (): Tally => ({ deploys: 0, lines: 0, places: [], files: 0, lostSales: 0, stuckRefunds: 0 });

export interface SideState {
  /** branch design: which providers each place knows */
  places: Record<Place, Provider[]>;
  /** strategy design: provider types that exist and are registered */
  types: Provider[];
  paypalFixed: boolean;
  payments: Payment[];
  lastBatch: Event[];
  total: Tally;
  /** the tally at the start of the current request, to show what this request cost */
  atRequestStart: Tally;
  batches: number;
}

/** 0: add Klarna. 1: PayPal changed its refund call. 2: finished. */
export type Request = 0 | 1 | 2;

export interface RequestResult { branch: Tally; strategy: Tally }
export interface State { request: Request; seq: number; branch: SideState; strategy: SideState; results: RequestResult[] }

export type Action =
  | { type: "editPlace"; place: Place }          // branch design: add Klarna to one place
  | { type: "addProvider" }                      // strategy design: add the Klarna type
  | { type: "fixPaypal"; side: Side }            // request 2, either design
  | { type: "next" }
  | { type: "reset" };

function side(): SideState {
  const history: Provider[] = ["stripe", "paypal", "adyen", "paypal"];
  return {
    places: { pay: [...START], refund: [...START], config: [...START] },
    types: [...START],
    paypalFixed: true,
    payments: history.map((p, i) => ({ id: 100 + i, provider: p, refunded: false })),
    lastBatch: [],
    total: zero(),
    atRequestStart: zero(),
    batches: 0,
  };
}

export function init(): State {
  return { request: 0, seq: 200, branch: side(), strategy: side(), results: [] };
}

/* ---------------- traffic ---------------- */

/** Small deterministic generator, so the k-th batch is the same on both sides. */
function rand(seed: number) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Providers a customer can pick: the config list, or the registered types. */
export function offered(s: SideState, d: Side): Provider[] {
  return d === "branch" ? s.places.config : s.types;
}

function pay(s: SideState, d: Side, p: Provider, id: number): Event {
  const name = NAME[p];
  if (d === "branch" && !s.places.pay.includes(p))
    return { id, kind: "pay", provider: p, ok: false, path: [`order ${id}`, "Checkout.Pay", "no case", "✗"], outcome: `Chose ${name} at checkout and got an error. Lost sale.` };
  s.payments.unshift({ id, provider: p, refunded: false });
  const hop = d === "branch" ? `case "${p}"` : "PaymentProvider";
  return { id, kind: "pay", provider: p, ok: true, path: [`order ${id}`, "Checkout.Pay", hop, name, "✓"], outcome: `Paid with ${name}.` };
}

function refund(s: SideState, d: Side, pm: Payment): Event {
  const p = pm.provider, name = NAME[p], id = pm.id;
  const hop = d === "branch" ? `case "${p}"` : "PaymentProvider";
  if (d === "branch" && !s.places.refund.includes(p))
    return { id, kind: "refund", provider: p, ok: false, path: [`refund ${id}`, "Checkout.Refund", "no case", "✗"], outcome: `Paid with ${name}, asked for a refund, and is stuck: Refund has no case for "${p}".` };
  if (p === "paypal" && !s.paypalFixed)
    return { id, kind: "refund", provider: p, ok: false, path: [`refund ${id}`, "Checkout.Refund", hop, "PayPal", "✗"], outcome: "PayPal rejected the old RefundSale call. Refund stuck." };
  pm.refunded = true;
  return { id, kind: "refund", provider: p, ok: true, path: [`refund ${id}`, "Checkout.Refund", hop, name, "✓"], outcome: `Refunded through ${name}.` };
}

/** One deploy's worth of traffic: 4 new orders, then 2 refund requests. */
function runBatch(prev: SideState, d: Side, seq: number, request: Request): { s: SideState; seq: number } {
  const s: SideState = { ...prev, payments: prev.payments.map((x) => ({ ...x })), total: { ...prev.total } };
  const r = rand(1000 + s.batches * 7919 + request * 31);
  const events: Event[] = [];
  const offer = offered(s, d);
  for (let i = 0; i < 4; i++) {
    // Once Klarna is offered, EU customers pick it often: it was just launched.
    const p: Provider = offer.includes("klarna") && r() < 0.45 ? "klarna" : START.filter((x) => offer.includes(x))[Math.floor(r() * 3) % START.length];
    const e = pay(s, d, p, ++seq);
    if (!e.ok) s.total.lostSales++;
    events.push(e);
  }
  // Refunds: customers ask for the newest payments back; during the PayPal request, PayPal ones first.
  const open = s.payments.filter((x) => !x.refunded);
  const queue = request === 1 ? [...open.filter((x) => x.provider === "paypal"), ...open.filter((x) => x.provider !== "paypal")] : open;
  for (const pm of queue.slice(0, 2)) {
    const e = refund(s, d, pm);
    if (!e.ok) s.total.stuckRefunds++;
    events.push(e);
  }
  s.lastBatch = events;
  s.batches++;
  return { s, seq };
}

/** A deploy: count it, then live traffic runs on the new code. */
function deploy(st: State, d: Side, change: (s: SideState) => SideState): State {
  const changed = change(st[d]);
  changed.total = { ...changed.total, deploys: changed.total.deploys + 1 };
  const { s, seq } = runBatch(changed, d, st.seq, st.request);
  return { ...st, seq, [d]: s };
}

/* ---------------- request status ---------------- */

export function sideDone(st: State, d: Side): boolean {
  const s = st[d];
  if (st.request === 0) return d === "branch" ? (["pay", "refund", "config"] as Place[]).every((pl) => s.places[pl].includes("klarna")) : s.types.includes("klarna");
  if (st.request === 1) return s.paypalFixed;
  return true;
}
export const requestDone = (st: State) => sideDone(st, "branch") && sideDone(st, "strategy");

/** What the current request has cost each side so far. */
export function requestCost(s: SideState): Tally {
  const a = s.atRequestStart, t = s.total;
  return {
    deploys: t.deploys - a.deploys,
    lines: t.lines - a.lines,
    places: t.places.slice(a.places.length),
    files: t.files - a.files,
    lostSales: t.lostSales - a.lostSales,
    stuckRefunds: t.stuckRefunds - a.stuckRefunds,
  };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "editPlace": {
      const s = st.branch;
      if (st.request !== 0 || s.places[a.place].includes("klarna")) return st;
      return deploy(st, "branch", (x) => ({
        ...x,
        places: { ...x.places, [a.place]: [...x.places[a.place], "klarna"] },
        total: { ...x.total, lines: x.total.lines + LINES[a.place], places: [...x.total.places, a.place] },
      }));
    }

    case "addProvider": {
      if (st.request !== 0 || st.strategy.types.includes("klarna")) return st;
      return deploy(st, "strategy", (x) => ({
        ...x,
        types: [...x.types, "klarna"],
        total: { ...x.total, files: x.total.files + 1, places: [...x.total.places, "klarna file"] },
      }));
    }

    case "fixPaypal": {
      if (st.request !== 1 || st[a.side].paypalFixed) return st;
      return deploy(st, a.side, (x) => ({
        ...x,
        paypalFixed: true,
        total: { ...x.total, lines: x.total.lines + 1, places: [...x.total.places, a.side === "branch" ? "refund" : "paypal file"] },
      }));
    }

    case "next": {
      if (!requestDone(st) || st.request === 2) return st;
      const request = (st.request + 1) as Request;
      const mark = (s: SideState): SideState => ({ ...s, atRequestStart: { ...s.total, places: [...s.total.places] }, lastBatch: [] });
      const results = [...st.results, { branch: requestCost(st.branch), strategy: requestCost(st.strategy) }];
      let next: State = { ...st, request, results, branch: mark(st.branch), strategy: mark(st.strategy) };
      if (request === 1) {
        // PayPal switches off RefundSale. Traffic keeps flowing: refunds fail on both sides until fixed.
        for (const d of ["branch", "strategy"] as Side[]) {
          const broken = { ...next[d], paypalFixed: false };
          const { s, seq } = runBatch(broken, d, next.seq, request);
          next = { ...next, seq, [d]: s };
        }
      }
      return next;
    }
  }
}
