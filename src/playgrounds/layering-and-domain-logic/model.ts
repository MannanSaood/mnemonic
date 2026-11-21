// Purpose: after this, the reader can answer: "Where does a pricing rule live in a transaction
// script, a domain model or the database, and how does that decide how many places every new
// rule must be written, and whether they can drift apart?"
// Core insight: transaction scripts are the cheapest way to write the first rules, but each rule
// is copied into every script that prices an order, and interacting rules (exclusions, a cap)
// cost more in every copy. A domain model costs more up front and then one place per rule. Logic
// in the database is one place for the code that can reach a row, and a second copy for the code
// that cannot.
//
// A shop prices the same cart from four entry points: the cart preview, checkout, reorder and the
// invoice. The reader receives five discount rules in order. For each, they click the places where
// they write it and ship. Every entry point then prices the same cart; if they disagree, a customer
// sees one price and pays another.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Style = "script" | "domain" | "db";
export const STYLES: Style[] = ["script", "domain", "db"];
export const STYLE_LABEL: Record<Style, string> = {
  script: "Transaction scripts",
  domain: "Domain model",
  db: "In the database",
};

export type Entry = "preview" | "checkout" | "reorder" | "invoice";
export const ENTRIES: Entry[] = ["preview", "checkout", "reorder", "invoice"];
export const ENTRY_LABEL: Record<Entry, string> = {
  preview: "Cart preview",
  checkout: "Checkout",
  reorder: "Reorder",
  invoice: "Invoice PDF",
};
export type Place = Entry | "shared";

/** The shared place, if the style has one, and which entry points reach it. */
export const SHARED: Record<Style, { label: string; reaches: Entry[] } | null> = {
  script: null,
  domain: { label: "Order (domain model)", reaches: ["preview", "checkout", "reorder", "invoice"] },
  // the cart preview prices a cart that has no order row yet, so it cannot call the SQL function
  db: { label: "price_order() in SQL", reaches: ["checkout", "reorder", "invoice"] },
};

export type RuleId = "over100" | "coupon" | "gold" | "giftcards" | "cap";
export interface Rule {
  id: RuleId;
  title: string;
  who: string;
  /** lines to write it into one script, before interactions */
  script: number;
  /** lines in the domain model (a new policy type, or one method) */
  domain: number;
  /** lines in the SQL function */
  sql: number;
  /** it changes how earlier rules work, so every copy edits the rules already there */
  interacts: boolean;
}
export const RULES: Rule[] = [
  { id: "over100", title: "10% off orders over $100", who: "Marketing", script: 3, domain: 6, sql: 3, interacts: false },
  { id: "coupon", title: "Coupon SPRING10 takes $10 off", who: "Marketing", script: 4, domain: 6, sql: 4, interacts: false },
  { id: "gold", title: "Gold members get 5% more", who: "Loyalty team", script: 3, domain: 6, sql: 3, interacts: false },
  { id: "giftcards", title: "Gift cards never get a discount", who: "Finance", script: 3, domain: 2, sql: 2, interacts: true },
  { id: "cap", title: "Discounts never exceed 20%", who: "Finance", script: 3, domain: 3, sql: 3, interacts: true },
];
export const rule = (id: RuleId) => RULES.find((r) => r.id === id)!;

/** Lines already written before the first rule: the Order, LineItem, policy type and mapper; or the SQL function. */
export const UPFRONT: Record<Style, number> = { script: 0, domain: 30, db: 8 };

/* ---------------- the cart everyone prices ---------------- */

export const CART = [
  { name: "Headphones", cents: 120_00, giftCard: false },
  { name: "USB-C cable", cents: 15_00, giftCard: false },
  { name: "Gift card", cents: 50_00, giftCard: true },
];
export const SUBTOTAL = CART.reduce((s, l) => s + l.cents, 0);

/** The price of the cart for a gold member with coupon SPRING10, under a set of rules. */
export function price(rules: RuleId[]): number {
  const has = (r: RuleId) => rules.includes(r);
  const eligible = has("giftcards") ? CART.filter((l) => !l.giftCard).reduce((s, l) => s + l.cents, 0) : SUBTOTAL;
  const pct = (has("over100") && eligible >= 100_00 ? 10 : 0) + (has("gold") ? 5 : 0);
  let discount = Math.round((eligible * pct) / 100) + (has("coupon") ? 10_00 : 0);
  if (has("cap")) discount = Math.min(discount, Math.round(eligible / 5));
  return SUBTOTAL - discount;
}
export const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/* ---------------- one codebase per style ---------------- */

export interface Shipped { rule: RuleId; places: Place[]; lines: number; migrations: number }
export interface Codebase {
  placed: Record<Place, RuleId[]>;
  shipped: Shipped[];
  /** places the reader has clicked for the next rule */
  pending: Place[];
}
const emptyCodebase = (): Codebase => ({
  placed: { preview: [], checkout: [], reorder: [], invoice: [], shared: [] },
  shipped: [],
  pending: [],
});

export interface State {
  style: Style;
  code: Record<Style, Codebase>;
  predict: string | null;
}

export type Action =
  | { type: "style"; style: Style }
  | { type: "place"; place: Place }
  | { type: "ship" }
  | { type: "undoStyle" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { style: "script", code: { script: emptyCodebase(), domain: emptyCodebase(), db: emptyCodebase() }, predict: null };
}

/** The next rule waiting to be written in this codebase, or null when all five are shipped. */
export const nextRule = (c: Codebase): Rule | null => RULES[c.shipped.length] ?? null;

export const places = (style: Style): Place[] => (SHARED[style] ? [...ENTRIES, "shared"] : [...ENTRIES]);

/** Lines it costs to write one rule into one place, given what is already there. */
export function linesFor(style: Style, r: Rule, place: Place, already: number): number {
  if (place === "shared") return style === "domain" ? r.domain : r.sql + (r.interacts ? already : 0);
  return r.script + (r.interacts ? already : 0);
}

/** The rules one entry point actually applies. */
export function rulesAt(style: Style, c: Codebase, e: Entry): RuleId[] {
  const shared = SHARED[style]?.reaches.includes(e) ? c.placed.shared : [];
  return [...new Set([...c.placed[e], ...shared])];
}
export const pricesOf = (style: Style, c: Codebase): Record<Entry, number> =>
  Object.fromEntries(ENTRIES.map((e) => [e, price(rulesAt(style, c, e))])) as Record<Entry, number>;

/** Entry points whose price differs from what the shipped rules say it should be. */
export function wrongAt(style: Style, c: Codebase): Entry[] {
  const want = price(c.shipped.map((s) => s.rule));
  const p = pricesOf(style, c);
  return ENTRIES.filter((e) => p[e] !== want);
}
export const disagree = (style: Style, c: Codebase) => new Set(Object.values(pricesOf(style, c))).size > 1;

export interface Totals { rules: number; lines: number; edits: number; migrations: number; copies: number; dbTests: number }
export function totals(style: Style, c: Codebase): Totals {
  const lines = UPFRONT[style] + c.shipped.reduce((s, x) => s + x.lines, 0);
  const edits = c.shipped.reduce((s, x) => s + x.places.length, 0);
  const migrations = c.shipped.reduce((s, x) => s + x.migrations, 0);
  // the most copies of any one rule
  const copies = c.shipped.reduce((m, x) => Math.max(m, x.places.length), 0);
  const dbTests = style === "db" ? c.placed.shared.length : 0;
  return { rules: c.shipped.length, lines, edits, migrations, copies, dbTests };
}

/**
 * Cumulative lines after k rules, written correctly (every entry point gets every rule) with the
 * fewest places each style allows. This is the curve the chart draws.
 */
export function idealCurve(style: Style): number[] {
  const out = [UPFRONT[style]];
  let total = UPFRONT[style];
  RULES.forEach((r, k) => {
    if (style === "script") total += ENTRIES.length * linesFor(style, r, "preview", k);
    else if (style === "domain") total += linesFor(style, r, "shared", k);
    else total += linesFor(style, r, "shared", k) + linesFor(style, r, "preview", k);
    out.push(total);
  });
  return out;
}
/** The first rule count at which the domain model has cost fewer lines than scripts. */
export function crossover(): number {
  const s = idealCurve("script"), d = idealCurve("domain");
  return s.findIndex((v, k) => k > 0 && d[k] < v);
}

export const PREDICT_ANSWER = String(crossover());
export const predictRevealed = (s: State) => STYLES.some((st) => s.code[st].shipped.length >= crossover());

export function step(s: State, a: Action): State {
  const c = s.code[s.style];
  const put = (next: Codebase): State => ({ ...s, code: { ...s.code, [s.style]: next } });
  switch (a.type) {
    case "reset":
      return init();
    case "style":
      return { ...s, style: a.style };
    case "undoStyle":
      return put(emptyCodebase());
    case "predict":
      return s.predict || predictRevealed(s) ? s : { ...s, predict: a.value };
    case "place": {
      if (!nextRule(c) || !places(s.style).includes(a.place)) return s;
      const pending = c.pending.includes(a.place) ? c.pending.filter((p) => p !== a.place) : [...c.pending, a.place];
      return put({ ...c, pending });
    }
    case "ship": {
      const r = nextRule(c);
      if (!r || c.pending.length === 0) return s;
      const placed = { ...c.placed };
      let lines = 0;
      for (const p of c.pending) {
        lines += linesFor(s.style, r, p, placed[p].length);
        placed[p] = [...placed[p], r.id];
      }
      const migrations = s.style === "db" && c.pending.includes("shared") ? 1 : 0;
      const order = places(s.style);
      const sorted = [...c.pending].sort((x, y) => order.indexOf(x) - order.indexOf(y));
      return put({ placed, pending: [], shipped: [...c.shipped, { rule: r.id, places: sorted, lines, migrations }] });
    }
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "drift", text: "As transaction scripts, ship a rule that makes the cart preview and checkout disagree." },
  { id: "scriptsAll", text: "Ship all five rules as transaction scripts with every price right." },
  { id: "domainAll", text: "Ship all five rules in the domain model, one place per rule." },
  { id: "dbGap", text: "In the database, find the screen the SQL function cannot reach." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  const sc = s.code.script, dm = s.code.domain, db = s.code.db;
  switch (id) {
    case "drift":
      return pricesOf("script", sc).preview !== pricesOf("script", sc).checkout;
    case "scriptsAll":
      return sc.shipped.length === RULES.length && wrongAt("script", sc).length === 0;
    case "domainAll":
      return dm.shipped.length === RULES.length && wrongAt("domain", dm).length === 0 && dm.shipped.every((x) => x.places.length === 1);
    case "dbGap":
      return db.shipped.some((x) => x.places.includes("shared")) && wrongAt("db", db).includes("preview");
  }
}
