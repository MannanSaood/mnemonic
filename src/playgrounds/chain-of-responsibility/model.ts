// Chain of Responsibility playground: support tickets travel down a chain of desks. Each desk
// either handles a ticket or passes it on. The reader reorders, adds and removes desks, breaks a
// desk so it swallows tickets, and sends the same eight tickets through.
//
// After this, the reader can answer: "The sender no longer decides who handles a request, so
// what does decide it, and what happens to a request nobody takes?"
// Core insight: in a chain, the ORDER of handlers decides who handles a request (and so what it
// costs), and nothing guarantees anyone handles it at all. You have to design the end of the
// chain: a final handler that takes everything, or an explicit "unhandled" result.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type HandlerId = "bot" | "tier1" | "tier2" | "eng" | "finance" | "lead";
export type TicketKind = "password" | "refund" | "dispute" | "outage" | "account" | "privacy";

export interface Ticket { id: number; kind: TicketKind; amount?: number; text: string }

export const TICKETS: Ticket[] = [
  { id: 1, kind: "password", text: "Can't log in, need a password reset" },
  { id: 2, kind: "refund", amount: 30, text: "Refund $30, wrong size" },
  { id: 3, kind: "dispute", amount: 2400, text: "Disputing a $2,400 annual charge" },
  { id: 4, kind: "outage", text: "Checkout returns 500 for every card" },
  { id: 5, kind: "refund", amount: 600, text: "Refund $600, double billed" },
  { id: 6, kind: "account", text: "Change the account's email address" },
  { id: 7, kind: "privacy", text: "Export all my data (GDPR request)" },
  { id: 8, kind: "password", text: "Password reset link expired" },
];

export interface Desk { id: HandlerId; name: string; rule: string; cost: number; can: (t: Ticket) => boolean }

export const DESKS: Record<HandlerId, Desk> = {
  bot: { id: "bot", name: "Help bot", rule: "password resets", cost: 0.1, can: (t) => t.kind === "password" },
  tier1: {
    id: "tier1", name: "Tier 1", rule: "passwords, account changes, refunds up to $100", cost: 4,
    can: (t) => t.kind === "password" || t.kind === "account" || (t.kind === "refund" && (t.amount ?? 0) <= 100),
  },
  tier2: {
    id: "tier2", name: "Tier 2 billing", rule: "account changes, refunds and disputes up to $1,000", cost: 15,
    can: (t) => t.kind === "account" || ((t.kind === "refund" || t.kind === "dispute") && (t.amount ?? 0) <= 1000),
  },
  eng: { id: "eng", name: "Engineering on-call", rule: "outages and bugs", cost: 60, can: (t) => t.kind === "outage" },
  finance: { id: "finance", name: "Finance lead", rule: "refunds and disputes of any size", cost: 40, can: (t) => t.kind === "refund" || t.kind === "dispute" },
  lead: { id: "lead", name: "Support lead", rule: "anything nobody else took, triaged by hand (catch-all)", cost: 80, can: () => true },
};
export const ALL: HandlerId[] = ["bot", "tier1", "tier2", "eng", "finance", "lead"];
const START: HandlerId[] = ["bot", "tier1", "tier2", "eng"];

export type Outcome = "handled" | "dropped" | "swallowed";
export interface Result {
  ticket: Ticket;
  /** Desks the ticket visited, in order, and whether each passed it on. */
  hops: { desk: HandlerId; took: boolean }[];
  outcome: Outcome;
  by?: HandlerId;
  cost: number;
}

export interface State {
  chain: HandlerId[];
  /** Break-it: a desk with a bug that neither handles nor passes on what it cannot handle. */
  swallows: HandlerId[];
  results: Result[];
  /** Index of the next ticket to send. */
  cursor: number;
  runs: number;
  prediction: string | null;
  /** Challenge flags, kept across runs. */
  sawDrop: boolean;
  cleanRun: boolean;
  sawOverpay: boolean;
  bestRun: boolean;
}

export type Action =
  | { type: "add"; id: HandlerId }
  | { type: "remove"; id: HandlerId }
  | { type: "move"; id: HandlerId; by: -1 | 1 }
  | { type: "toggleSwallow"; id: HandlerId }
  | { type: "send" }
  | { type: "sendAll" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return { chain: [...START], swallows: [], results: [], cursor: 0, runs: 0, prediction: null, sawDrop: false, cleanRun: false, sawOverpay: false, bestRun: false };
}

/** Pass the ticket down the chain until a desk takes it. */
export function route(chain: HandlerId[], swallows: HandlerId[], t: Ticket): Result {
  const hops: Result["hops"] = [];
  for (const id of chain) {
    const d = DESKS[id];
    if (d.can(t)) {
      hops.push({ desk: id, took: true });
      return { ticket: t, hops, outcome: "handled", by: id, cost: d.cost };
    }
    hops.push({ desk: id, took: false });
    if (swallows.includes(id)) return { ticket: t, hops, outcome: "swallowed", cost: 0 };
  }
  return { ticket: t, hops, outcome: "dropped", cost: 0 };
}

/** The cheapest desk that could handle this ticket, among all desks. */
export function cheapest(t: Ticket): number {
  return Math.min(...ALL.map((id) => DESKS[id]).filter((d) => d.can(t)).map((d) => d.cost));
}
export const BEST_COST = TICKETS.reduce((a, t) => a + cheapest(t), 0);

export function summary(results: Result[]) {
  const handled = results.filter((r) => r.outcome === "handled");
  const lost = results.filter((r) => r.outcome !== "handled");
  const cost = handled.reduce((a, r) => a + r.cost, 0);
  const overpaid = handled.reduce((a, r) => a + (r.cost - cheapest(r.ticket)), 0);
  const hops = results.reduce((a, r) => a + r.hops.length, 0);
  return { handled: handled.length, lost: lost.length, cost: round(cost), overpaid: round(overpaid), hops };
}
const round = (x: number) => Math.round(x * 100) / 100;

function sendOne(s: State): State {
  // A finished run starts over with the same eight tickets.
  const fresh = s.cursor >= TICKETS.length;
  const base = fresh ? { ...s, results: [], cursor: 0 } : s;
  const r = route(base.chain, base.swallows, TICKETS[base.cursor]);
  const results = [...base.results, r];
  const cursor = base.cursor + 1;
  const next: State = { ...base, results, cursor, runs: base.runs + (cursor === TICKETS.length ? 1 : 0), sawDrop: s.sawDrop || r.outcome !== "handled" };
  if (cursor === TICKETS.length) {
    const sm = summary(results);
    next.cleanRun = s.cleanRun || sm.lost === 0;
    next.sawOverpay = s.sawOverpay || sm.overpaid >= 10;
    next.bestRun = s.bestRun || (sm.lost === 0 && sm.cost <= BEST_COST + 1e-9);
  }
  return next;
}

/** Changing the chain restarts the run, so every run uses one chain. */
const restart = (s: State, patch: Partial<State>): State => ({ ...s, ...patch, results: [], cursor: 0 });

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "add":
      return s.chain.includes(a.id) ? s : restart(s, { chain: [...s.chain, a.id] });
    case "remove":
      return restart(s, { chain: s.chain.filter((x) => x !== a.id), swallows: s.swallows.filter((x) => x !== a.id) });
    case "move": {
      const i = s.chain.indexOf(a.id), j = i + a.by;
      if (i < 0 || j < 0 || j >= s.chain.length) return s;
      const chain = [...s.chain];
      [chain[i], chain[j]] = [chain[j], chain[i]];
      return restart(s, { chain });
    }
    case "toggleSwallow":
      return restart(s, { swallows: s.swallows.includes(a.id) ? s.swallows.filter((x) => x !== a.id) : [...s.swallows, a.id] });
    case "send":
      return sendOne(s);
    case "sendAll": {
      let next: State = s.cursor >= TICKETS.length ? { ...s, results: [], cursor: 0 } : s;
      while (next.cursor < TICKETS.length) next = sendOne(next);
      return next;
    }
  }
}

/** Has the $2,400 dispute been sent in the current run? Used to reveal the prediction. */
export const disputeResult = (s: State) => s.results.find((r) => r.ticket.id === 3);

export const CHALLENGES = [
  { id: "drop", text: "Send all eight tickets through the starting chain. Which ones fall off the end?" },
  { id: "clean", text: "Change the chain so a full run loses nothing." },
  { id: "overpay", text: "Move Tier 2 billing to the front and run again. Watch the cost." },
  { id: "best", text: "Find a chain that loses nothing at the lowest possible cost." },
] as const;

export function challengeDone(s: State, id: (typeof CHALLENGES)[number]["id"]): boolean {
  switch (id) {
    case "drop": return s.sawDrop;
    case "clean": return s.cleanRun;
    case "overpay": return s.sawOverpay;
    case "best": return s.bestRun;
  }
}
