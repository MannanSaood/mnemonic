// Purpose: after this, the reader can answer: "Which way may an import point, and what does one
// import pointing the wrong way cost when the database or the web framework is replaced?"
// Core insight: if every source dependency points inward, replacing an outer ring (the database,
// the web framework) edits only the outer ring and main. One outward import drags the business
// rules into every such swap, and into every test.
//
// A refund service drawn as nested rings: entities, use cases, adapters, frameworks and drivers.
// The base design follows the Dependency Rule. The reader toggles real shortcut import lines
// (each is something a busy engineer really writes), sees which ones break the rule, then swaps
// the database or the web framework and counts the files that must change.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Mod = "entity" | "usecase" | "handler" | "pgrepo" | "mailer" | "web" | "driver" | "smtp" | "main";
export const MODS: Mod[] = ["entity", "usecase", "handler", "pgrepo", "mailer", "web", "driver", "smtp", "main"];

/** 0 = entities (innermost), 1 = use cases, 2 = interface adapters, 3 = frameworks and drivers. */
export const RING: Record<Mod, number> = {
  entity: 0, usecase: 1, handler: 2, pgrepo: 2, mailer: 2, web: 3, driver: 3, smtp: 3, main: 3,
};
export const RING_NAME = ["Entities", "Use cases", "Interface adapters", "Frameworks & drivers"];
/** The two inner rings hold the business rules. */
export const isBusiness = (m: Mod) => RING[m] <= 1;

export interface Edge { from: Mod; to: Mod }

/** The design that follows the rule. Main imports everything and is not drawn. */
export const BASE: Edge[] = [
  { from: "usecase", to: "entity" },
  { from: "handler", to: "usecase" },
  { from: "handler", to: "web" },
  { from: "pgrepo", to: "usecase" },
  { from: "pgrepo", to: "entity" },
  { from: "pgrepo", to: "driver" },
  { from: "mailer", to: "usecase" },
  { from: "mailer", to: "smtp" },
];

export type ShortcutId = "ucDriver" | "ucRepo" | "ucWeb" | "entityDb" | "handlerRepo";
export interface Shortcut { id: ShortcutId; from: Mod; to: Mod; why: string }
export const SHORTCUTS: Shortcut[] = [
  { id: "ucDriver", from: "usecase", to: "driver", why: "The use case catches the database library's serialization error so it can retry the refund." },
  { id: "ucRepo", from: "usecase", to: "pgrepo", why: "The use case builds the Postgres repository itself instead of being handed a port." },
  { id: "ucWeb", from: "usecase", to: "web", why: "The use case takes the framework's request object to read the support agent's id." },
  { id: "entityDb", from: "entity", to: "driver", why: "The Order entity gets the database library's types so it can be scanned straight from a row." },
  { id: "handlerRepo", from: "handler", to: "pgrepo", why: "The handler reads the order from the Postgres repository to show it next to the refund." },
];

export type SwapId = "db" | "web";
export const SWAPS: Record<SwapId, { title: string; replaced: Mod; rewritten: Mod; why: string }> = {
  db: { title: "Move from Postgres to DynamoDB", replaced: "driver", rewritten: "pgrepo", why: "The platform team is retiring the shared Postgres cluster." },
  web: { title: "Replace the web framework", replaced: "web", rewritten: "handler", why: "The old framework is out of support." },
};
export const SWAP_IDS: SwapId[] = ["db", "web"];

export interface State {
  on: ShortcutId[];
  swap: SwapId | null;
  /** swaps done, with the inner-ring edits each cost at the time */
  log: { swap: SwapId; on: ShortcutId[]; businessEdits: number; edited: number }[];
  /** log length when a rule-breaking import was last switched on (for the "back to zero" challenge) */
  brokeAt: number | null;
  predict: string | null;
}

export type Action =
  | { type: "toggle"; id: ShortcutId }
  | { type: "swap"; swap: SwapId }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { on: [], swap: null, log: [], brokeAt: null, predict: null };
}

export function edges(on: ShortcutId[]): (Edge & { shortcut?: ShortcutId })[] {
  return [...BASE, ...SHORTCUTS.filter((s) => on.includes(s.id)).map((s) => ({ from: s.from, to: s.to, shortcut: s.id }))];
}

/**
 * An import breaks the rule when it points from the business rules (entities, use cases) to a
 * ring further out. Adapters importing the library they wrap is their whole job: an adapter is
 * the glue between a framework and a port.
 */
export const breaksRule = (e: Edge) => RING[e.from] < RING[e.to] && isBusiness(e.from);
export const violations = (on: ShortcutId[]) => edges(on).filter(breaksRule);

/** Everything a module reaches through its imports, itself excluded. */
export function reach(on: ShortcutId[], from: Mod): Mod[] {
  const g = edges(on);
  const seen = new Set<Mod>();
  const todo: Mod[] = [from];
  while (todo.length) {
    const m = todo.pop()!;
    for (const e of g) if (e.from === m && !seen.has(e.to)) { seen.add(e.to); todo.push(e.to); }
  }
  return [...seen];
}

/** Outer-ring pieces the use case's unit test drags in. Empty means it runs with plain fakes. */
export const testDrags = (on: ShortcutId[]): Mod[] => reach(on, "usecase").filter((m) => !isBusiness(m));

export interface SwapResult {
  /** the adapter rewritten for the new technology (expected) */
  rewritten: Mod;
  /** modules edited besides the rewritten adapter and main */
  edited: Mod[];
  /** edited modules in the inner two rings */
  business: Mod[];
  /** modules that must be rebuilt and retested because something they import changed */
  retested: Mod[];
}

export function swapCost(on: ShortcutId[], id: SwapId): SwapResult {
  const { replaced, rewritten } = SWAPS[id];
  const g = edges(on);
  const edited = [...new Set(g.filter((e) => (e.to === replaced || e.to === rewritten) && e.from !== rewritten).map((e) => e.from))]
    .filter((m) => m !== "main");
  const changed = new Set<Mod>([replaced, rewritten, ...edited]);
  const retested = new Set<Mod>();
  for (let grew = true; grew;) {
    grew = false;
    for (const e of g)
      if ((changed.has(e.to) || retested.has(e.to)) && !changed.has(e.from) && !retested.has(e.from)) { retested.add(e.from); grew = true; }
  }
  return { rewritten, edited, business: edited.filter(isBusiness), retested: [...retested] };
}

export const PREDICT_ANSWER = "0";
export const predictRevealed = (s: State) => s.log.some((l) => l.swap === "db");

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "toggle": {
      const on = s.on.includes(a.id) ? s.on.filter((x) => x !== a.id) : [...s.on, a.id];
      const breaks = !s.on.includes(a.id) && violations([a.id]).length > 0;
      return { ...s, on, swap: null, brokeAt: breaks ? s.log.length : s.brokeAt };
    }
    case "swap": {
      const r = swapCost(s.on, a.swap);
      return { ...s, swap: a.swap, log: [...s.log, { swap: a.swap, on: s.on, businessEdits: r.business.length, edited: r.edited.length }] };
    }
    case "predict":
      return s.predict || predictRevealed(s) ? s : { ...s, predict: a.value };
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "untestable", text: "Add one import that makes the use case's unit test need a real database." },
  { id: "center", text: "Break the rule from the very center: make the entity depend on a framework." },
  { id: "legal", text: "Find the import the rule allows that still makes the database swap edit one more file." },
  { id: "clean", text: "After breaking the rule, swap both the database and the web framework with zero business edits." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  switch (id) {
    case "untestable":
      return testDrags(s.on).includes("driver");
    case "center":
      return s.on.includes("entityDb");
    case "legal":
      return s.log.some((l) => l.swap === "db" && l.on.includes("handlerRepo") && l.edited > 0)
        && !violations(["handlerRepo"]).length;
    case "clean": {
      if (s.brokeAt === null) return false;
      const after = s.log.slice(s.brokeAt); // only swaps made since the rule was last broken
      return after.some((l) => l.swap === "db" && l.businessEdits === 0) && after.some((l) => l.swap === "web" && l.businessEdits === 0);
    }
  }
}

/** Modules caught in an import cycle (Go and Cargo refuse to build these). */
export function inCycle(on: ShortcutId[]): Mod[] {
  return MODS.filter((m) => reach(on, m).includes(m));
}
