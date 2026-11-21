// Purpose. After this, the reader can answer: "When one module's internals change, which other
// modules have to change too, and why does that depend on who reaches into whose data?"
//
// The model: an order service of five modules, in two designs.
// - tangled: modules read and write each other's data directly, and some logic lives far from
//   the data it is about (Orders computes tax; Email recomputes it).
// - cohesive: each module owns its data and answers questions about it through a few methods.
// The reader clicks an internal detail ("fact") to change it. A ripple spreads: the owner changes,
// then every module that uses the fact directly (hop 1), then every module that uses something
// derived from it (hop 2). The same change is always measured in both designs (a counterfactual),
// and shortcuts let the reader break the cohesive design one reach-in at a time.
//
// Plain data + pure functions, so it can be tested without a browser.

export type ModuleId = "orders" | "inventory" | "pricing" | "shipping" | "email";
export type Design = "tangled" | "cohesive";
export type FactId = "stock" | "price" | "tax" | "status" | "carrier" | "template" | "total";
export type ShortcutId = "shipReadsStock" | "emailTax" | "shipStatus";

export const MODULES: { id: ModuleId; name: string; team: string }[] = [
  { id: "orders", name: "Orders", team: "Checkout" },
  { id: "inventory", name: "Inventory", team: "Warehouse" },
  { id: "pricing", name: "Pricing", team: "Finance" },
  { id: "shipping", name: "Shipping", team: "Logistics" },
  { id: "email", name: "Email", team: "CRM" },
];
export const MODULE = Object.fromEntries(MODULES.map((m) => [m.id, m])) as Record<ModuleId, (typeof MODULES)[number]>;

export interface Fact { id: FactId; owner: ModuleId; label: string; change?: string }
export const FACTS: Fact[] = [
  { id: "stock", owner: "inventory", label: "stock map", change: "A second warehouse opens: stock is now kept per warehouse." },
  { id: "price", owner: "pricing", label: "price as float", change: "Finance wants prices in integer cents, to stop rounding errors." },
  { id: "tax", owner: "pricing", label: "tax rules", change: "EU VAT: the tax rate now depends on the customer's country and the product type." },
  { id: "status", owner: "orders", label: "status values", change: 'A new order status: "partially shipped".' },
  { id: "carrier", owner: "shipping", label: "carrier API", change: "Logistics switches carrier from UPS to DHL." },
  { id: "template", owner: "email", label: "email layout", change: "Marketing rebrands every email." },
  { id: "total", owner: "orders", label: "order total" },
];
export const FACT = Object.fromEntries(FACTS.map((f) => [f.id, f])) as Record<FactId, Fact>;
/** Facts the reader can change (the derived total is changed only by a ripple). */
export const CHANGEABLE: FactId[] = ["stock", "price", "tax", "status", "carrier", "template"];

/** "module uses fact at where". If carries is set, the module's own fact changes shape too. */
export interface Use { fact: FactId; module: ModuleId; where: string; carries?: FactId }

const TANGLED: Use[] = [
  { fact: "stock", module: "orders", where: "Orders.place decrements inventory.stock[sku] itself" },
  { fact: "stock", module: "shipping", where: "Shipping.promise reads inventory.stock[sku]" },
  { fact: "price", module: "orders", where: "Orders.total adds up line prices as floats", carries: "total" },
  { fact: "tax", module: "orders", where: "Orders.total looks up pricing.taxRates[country]", carries: "total" },
  { fact: "tax", module: "email", where: "Email.receipt recomputes the tax line to show it" },
  { fact: "total", module: "email", where: 'Email.receipt formats order.total with "%.2f"' },
  { fact: "total", module: "shipping", where: "Shipping gives free shipping when order.total >= 50.0" },
  { fact: "status", module: "shipping", where: 'Shipping.ready checks status == "paid"' },
  { fact: "status", module: "email", where: "Email picks a template with a switch on status" },
];

const COHESIVE: Use[] = [
  // A genuinely new behaviour still needs work where it shows: a new email for the new status.
  { fact: "status", module: "email", where: "Email needs a new message for the new status (real new work)" },
];

export const SHORTCUTS: { id: ShortcutId; label: string; use: Use }[] = [
  { id: "shipReadsStock", label: "Shipping reads Inventory's stock map directly, to save a call", use: { fact: "stock", module: "shipping", where: "Shipping.promise reads inventory.stock[sku] (shortcut)" } },
  { id: "emailTax", label: "Email recomputes tax for the receipt instead of asking Pricing", use: { fact: "tax", module: "email", where: "Email.receipt recomputes the tax line (shortcut)" } },
  { id: "shipStatus", label: 'Shipping compares order.status == "paid" instead of calling order.canShip()', use: { fact: "status", module: "shipping", where: 'Shipping.ready checks status == "paid" (shortcut)' } },
];

export function uses(design: Design, shortcuts: ShortcutId[]): Use[] {
  if (design === "tangled") return TANGLED;
  return [...COHESIVE, ...SHORTCUTS.filter((s) => shortcuts.includes(s.id)).map((s) => s.use)];
}

/** Where the cohesive design answers questions instead of exposing data. */
export const API: Record<ModuleId, string> = {
  orders: "place(cart) · canShip()",
  inventory: "available(sku) · reserve(lines)",
  pricing: "quote(cart) → Money",
  shipping: "promise(line) · book(order)",
  email: "send(kind, order)",
};

export interface Hit { module: ModuleId; hop: number; where: string; fact: FactId }
export interface Ripple { fact: FactId; hits: Hit[]; modules: ModuleId[]; places: number; teams: number; maxHop: number; inOwner: number }

/** Spread a change from a fact: the owner (hop 0), its direct users (hop 1), users of carried facts (hop 2+). */
export function ripple(design: Design, shortcuts: ShortcutId[], fact: FactId): Ripple {
  const all = uses(design, shortcuts);
  const hits: Hit[] = [{ module: FACT[fact].owner, hop: 0, where: `${MODULE[FACT[fact].owner].name} changes its ${FACT[fact].label}`, fact }];
  const seenFacts = new Set<FactId>([fact]);
  let frontier: FactId[] = [fact];
  let hop = 0;
  while (frontier.length) {
    hop++;
    const next: FactId[] = [];
    for (const f of frontier)
      for (const u of all.filter((x) => x.fact === f)) {
        hits.push({ module: u.module, hop, where: u.where, fact: f });
        if (u.carries && !seenFacts.has(u.carries)) { seenFacts.add(u.carries); next.push(u.carries); }
      }
    frontier = next;
  }
  const modules = [...new Set(hits.map((h) => h.module))];
  const owner = FACT[fact].owner;
  return {
    fact,
    hits,
    modules,
    places: hits.length,
    teams: modules.length,
    maxHop: Math.max(...hits.map((h) => h.hop)),
    inOwner: hits.filter((h) => h.module === owner).length,
  };
}

export interface ChangeRecord { fact: FactId; tangled: Ripple; cohesive: Ripple; shortcuts: number }

export interface State {
  design: Design;
  shortcuts: ShortcutId[];
  current: Ripple | null;
  history: ChangeRecord[];
}

export type Action =
  | { type: "design"; design: Design }
  | { type: "change"; fact: FactId }
  | { type: "shortcut"; id: ShortcutId }
  | { type: "reset" };

export function init(): State {
  return { design: "tangled", shortcuts: [], current: null, history: [] };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "design": {
      if (a.design === st.design) return st;
      const current = st.current ? ripple(a.design, st.shortcuts, st.current.fact) : null;
      return { ...st, design: a.design, current };
    }
    case "change": {
      if (!CHANGEABLE.includes(a.fact)) return st;
      const rec: ChangeRecord = { fact: a.fact, tangled: ripple("tangled", [], a.fact), cohesive: ripple("cohesive", st.shortcuts, a.fact), shortcuts: st.shortcuts.length };
      return { ...st, current: ripple(st.design, st.shortcuts, a.fact), history: [rec, ...st.history.filter((h) => h.fact !== a.fact)] };
    }
    case "shortcut": {
      const shortcuts = st.shortcuts.includes(a.id) ? st.shortcuts.filter((x) => x !== a.id) : [...st.shortcuts, a.id];
      const current = st.current ? ripple(st.design, shortcuts, st.current.fact) : null;
      // keep the history honest: re-measure the cohesive side of every change made so far
      const history = st.history.map((h) => ({ ...h, cohesive: ripple("cohesive", shortcuts, h.fact), shortcuts: shortcuts.length }));
      return { ...st, shortcuts, current, history };
    }
  }
}
