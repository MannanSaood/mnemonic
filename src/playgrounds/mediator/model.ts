// Mediator playground: one checkout page, wired two ways, taking the same customer actions and
// the same change requests.
//
// After this, the reader can answer: why does wiring components directly to each other make
// every new component edit several existing ones and turn one click into a cascade (or a loop),
// and what does routing everything through one mediator buy and cost?
//
// "Wired" is the lesson's before code: each component holds references to the components it
// must update and calls them directly, synchronously, depth first. "Mediator" is the after code:
// each component tells the mediator, which updates every affected component once, in order.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const BASE = ["cart", "country", "promo", "payment", "summary", "placeOrder"] as const;
export const ADDONS = ["giftCard", "loyalty", "deliverySlot"] as const;
export type Base = (typeof BASE)[number];
export type Addon = (typeof ADDONS)[number];
export type Comp = Base | Addon;
export type Side = "wired" | "mediator";

export const NAME: Record<Comp, string> = {
  cart: "Cart", country: "Country", promo: "Promo code", payment: "Payment", summary: "Summary", placeOrder: "Place order",
  giftCard: "Gift card", loyalty: "Loyalty points", deliverySlot: "Delivery slot",
};

/** Who must react when a component changes: in the wired design, who it calls. */
const BASE_CALLS: [Comp, Comp][] = [
  ["cart", "summary"], ["cart", "promo"], ["cart", "placeOrder"],
  ["country", "summary"], ["country", "payment"], ["country", "promo"],
  ["promo", "summary"],
  ["payment", "placeOrder"],
  ["summary", "placeOrder"],
];

export const ADDON_INFO: Record<Addon, { why: string; calls: [Comp, Comp][]; rules: number }> = {
  giftCard: {
    why: "A gift card lowers the total, and if it covers the whole order no payment method is needed.",
    calls: [["giftCard", "summary"], ["giftCard", "payment"], ["giftCard", "placeOrder"], ["cart", "giftCard"]],
    rules: 3,
  },
  loyalty: {
    why: "Customers can spend loyalty points, but not together with a promo code: using one clears the other.",
    calls: [["loyalty", "summary"], ["loyalty", "promo"], ["promo", "loyalty"]],
    rules: 2,
  },
  deliverySlot: {
    why: "Customers pick a delivery slot. Slots depend on the country, cost a fee, and are required to order.",
    calls: [["deliverySlot", "summary"], ["deliverySlot", "placeOrder"], ["country", "deliverySlot"]],
    rules: 3,
  },
};

/** The mediator's rule count for the base page: one per kind of reaction it coordinates. */
export const BASE_RULES = 6;
export const GOD_OBJECT_RULES = 12;
/** A synchronous cascade deeper than this is a loop; real code overflows the stack or hangs. */
export const LOOP_LIMIT = 24;

export interface Hop { from: Comp | "mediator"; to: Comp | "mediator" }
export interface Run { source: Comp; hops: Hop[]; updates: Partial<Record<Comp, number>>; loop: boolean }
export interface ChangeCost { addon: Addon; wiredFiles: Comp[]; mediatorFiles: string[]; newLinksWired: number; mediatorRules: number }

export interface State {
  comps: Comp[];
  calls: [Comp, Comp][];
  rules: number;
  last: { wired: Run; mediator: Run } | null;
  clicks: number;
  costs: ChangeCost[];
  loopsSeen: number;
  redundantSeen: number;
}

export type Action = { type: "change"; comp: Comp } | { type: "add"; addon: Addon } | { type: "reset" };

export function init(): State {
  return { comps: [...BASE], calls: BASE_CALLS.map((c) => [...c] as [Comp, Comp]), rules: BASE_RULES, last: null, clicks: 0, costs: [], loopsSeen: 0, redundantSeen: 0 };
}

/* ---------------- graph facts ---------------- */

const targets = (calls: [Comp, Comp][], c: Comp) => calls.filter(([a]) => a === c).map(([, b]) => b);

/** Pairs of components that know each other in the wired design. */
export function wiredLinks(calls: [Comp, Comp][]): number {
  return new Set(calls.map(([a, b]) => [a, b].sort().join("|"))).size;
}
export const mediatorLinks = (comps: Comp[]) => comps.length;
export const possiblePairs = (n: number) => (n * (n - 1)) / 2;

/** Every component that must end up updated when `c` changes (the reach of its calls). */
export function affected(calls: [Comp, Comp][], c: Comp): Comp[] {
  const seen = new Set<Comp>();
  const stack = [...targets(calls, c)];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === c || seen.has(x)) continue;
    seen.add(x);
    stack.push(...targets(calls, x));
  }
  return [...seen];
}

/* ---------------- running an event ---------------- */

/** Wired: each component calls its dependents directly, depth first, every time it updates. */
export function runWired(calls: [Comp, Comp][], source: Comp): Run {
  const hops: Hop[] = [];
  const updates: Partial<Record<Comp, number>> = {};
  let loop = false;
  const visit = (c: Comp) => {
    for (const t of targets(calls, c)) {
      if (hops.length >= LOOP_LIMIT) { loop = true; return; }
      hops.push({ from: c, to: t });
      updates[t] = (updates[t] ?? 0) + 1;
      visit(t);
      if (loop) return;
    }
  };
  visit(source);
  return { source, hops, updates, loop };
}

/** Mediator: the source tells the mediator; it updates every affected component once. */
export function runMediator(calls: [Comp, Comp][], comps: Comp[], source: Comp): Run {
  const hit = affected(calls, source);
  const order = comps.filter((c) => hit.includes(c));
  const hops: Hop[] = [{ from: source, to: "mediator" }, ...order.map((c) => ({ from: "mediator" as const, to: c }))];
  return { source, hops, updates: Object.fromEntries(order.map((c) => [c, 1])), loop: false };
}

/** Updates beyond the first, per component: each one is a moment the page showed stale data. */
export const redundant = (r: Run) => Object.values(r.updates).reduce((s, k) => s + Math.max(0, (k ?? 0) - 1), 0);

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "change": {
      if (!st.comps.includes(a.comp)) return st;
      const wired = runWired(st.calls, a.comp);
      const mediator = runMediator(st.calls, st.comps, a.comp);
      return {
        ...st,
        last: { wired, mediator },
        clicks: st.clicks + 1,
        loopsSeen: st.loopsSeen + (wired.loop ? 1 : 0),
        redundantSeen: st.redundantSeen + redundant(wired),
      };
    }
    case "add": {
      if (st.comps.includes(a.addon)) return st;
      const info = ADDON_INFO[a.addon];
      // Wired: every existing component the new one calls must accept its input, and every
      // existing component that must call it gains a reference and a call.
      const files = new Set<Comp>();
      for (const [from, to] of info.calls) {
        if (from === a.addon && to !== a.addon) files.add(to);
        if (to === a.addon && from !== a.addon) files.add(from);
      }
      const calls = [...st.calls, ...info.calls];
      const cost: ChangeCost = {
        addon: a.addon,
        wiredFiles: [...files],
        mediatorFiles: ["mediator"],
        newLinksWired: wiredLinks(calls) - wiredLinks(st.calls),
        mediatorRules: info.rules,
      };
      return { ...st, comps: [...st.comps, a.addon], calls, rules: st.rules + info.rules, costs: [...st.costs, cost], last: null };
    }
  }
}
