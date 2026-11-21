// Purpose. After this, the reader can answer: "Why does adding one feature to an HTTP client built
// by subclassing create a class per combination, while wrappers add one piece, and what do I
// get to decide (the order of the layers) that a class tree decides for me?"
//
// The model has two parts that share the same teams:
// 1. The explosion. Four teams each need a mix of features (retry, auth, logging). The
//    inheritance design needs one class per distinct mix; a class can inherit at most one
//    parent's features and must re-implement the rest, so feature code gets copied. The
//    composition design needs one wrapper per feature, stacked per team.
// 2. The stack. For one team, the reader reorders the wrappers and sends a request whose first
//    attempt fails with 503. The trace shows that order changes behaviour: how many log lines,
//    what latency the log reports, how many tokens are fetched.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Feature = "logging" | "retry" | "auth";
export const FEATURES: Feature[] = ["logging", "retry", "auth"];
export const FNAME: Record<Feature, string> = { logging: "Logging", retry: "Retry", auth: "Auth" };
/** Default stack order, outermost first. */
const CANON: Feature[] = ["logging", "retry", "auth"];

export type TeamId = "payments" | "search" | "admin" | "webhooks";
export const TEAMS: { id: TeamId; name: string }[] = [
  { id: "payments", name: "Payments" },
  { id: "search", name: "Search" },
  { id: "admin", name: "Admin" },
  { id: "webhooks", name: "Webhooks" },
];

export interface State {
  /** Each team's features, outermost layer first. */
  teams: Record<TeamId, Feature[]>;
  selected: TeamId;
  trace: Trace | null;
  /** Whether Security's request (logging everywhere) has been applied. */
  loggingEverywhere: boolean;
  /** Every mix that ever got a class, in the order the classes were written. */
  born: string[];
  /** Class count before the request, for the result. */
  before: { classes: number; copies: number } | null;
}

export type Action =
  | { type: "toggle"; team: TeamId; feature: Feature }
  | { type: "logEverywhere" }
  | { type: "select"; team: TeamId }
  | { type: "move"; feature: Feature; dir: -1 | 1 }
  | { type: "send" }
  | { type: "reset" };

export function init(): State {
  return {
    teams: { payments: ["retry", "auth"], search: ["retry"], admin: ["auth"], webhooks: [] },
    born: ["retry", "auth", "retry+auth"],
    selected: "payments",
    trace: null,
    loggingEverywhere: false,
    before: null,
  };
}

/* ---------------- part 1: the class tree ---------------- */

const key = (fs: Feature[]) => [...fs].sort((a, b) => FEATURES.indexOf(a) - FEATURES.indexOf(b)).join("+");

export interface ClassNode {
  name: string;
  features: Feature[];
  parent: string;
  /** Features this class must implement itself, because its parent does not have them. */
  own: Feature[];
  teams: TeamId[];
}

/** The class name a team would use for a mix, in the usual style: LoggingAuthRetryingClient. */
export function className(fs: Feature[]): string {
  if (!fs.length) return "HttpClient";
  const word: Record<Feature, string> = { logging: "Logging", auth: "Auth", retry: "Retrying" };
  return ["logging", "auth", "retry"].filter((f) => fs.includes(f as Feature)).map((f) => word[f as Feature]).join("") + "Client";
}

/**
 * Single inheritance, grown the way teams grow it: each new mix becomes a subclass of the largest
 * mix that existed before it (ties go to the older class). A class must implement every feature its
 * parent lacks. Classes stay while any team uses them or a used class inherits from them.
 */
export function classTree(st: State): ClassNode[] {
  const feats = (k: string) => (k ? (k.split("+") as Feature[]) : []);
  const parentOf = new Map<string, string>();
  st.born.forEach((k, i) => {
    const fs = feats(k);
    let best = "";
    for (const p of st.born.slice(0, i)) {
      const pf = feats(p);
      if (pf.length < fs.length && pf.every((f) => fs.includes(f)) && pf.length > feats(best).length) best = p;
    }
    parentOf.set(k, best);
  });
  const usedBy = new Map<string, TeamId[]>();
  for (const t of TEAMS) {
    const k = key(st.teams[t.id]);
    if (k) usedBy.set(k, [...(usedBy.get(k) ?? []), t.id]);
  }
  const keep = new Set<string>();
  for (const k of usedBy.keys()) for (let c = k; c; c = parentOf.get(c) ?? "") keep.add(c);
  return st.born.filter((k) => keep.has(k)).map((k) => {
    const fs = feats(k), p = parentOf.get(k) ?? "";
    return { name: className(fs), features: fs, parent: p ? className(feats(p)) : "HttpClient", own: fs.filter((f) => !feats(p).includes(f)), teams: usedBy.get(k) ?? [] };
  });
}

/** Record mixes that just appeared, in team order. */
function grow(born: string[], teams: Record<TeamId, Feature[]>): string[] {
  const out = [...born];
  for (const t of TEAMS) { const k = key(teams[t.id]); if (k && !out.includes(k)) out.push(k); }
  return out;
}

export interface Counts {
  /** Classes beyond the base client. */
  classes: number;
  /** Feature blocks written more than once (each extra copy counts one). */
  copies: number;
  /** Places to edit to fix a bug in each feature. */
  fixes: Record<Feature, number>;
  /** Composition: wrappers that exist (one per feature any team uses). */
  wrappers: number;
}

export function counts(st: State): Counts {
  const tree = classTree(st);
  const fixes = { logging: 0, retry: 0, auth: 0 } as Record<Feature, number>;
  for (const c of tree) for (const f of c.own) fixes[f]++;
  const used = FEATURES.filter((f) => TEAMS.some((t) => st.teams[t.id].includes(f)));
  const copies = FEATURES.reduce((a, f) => a + Math.max(0, fixes[f] - 1), 0);
  return { classes: tree.length, copies, fixes, wrappers: used.length };
}

/** The composition expression for a team, e.g. Logging(Retry(Auth(Http))). */
export function stackExpr(fs: Feature[]): string {
  return fs.reduceRight((inner, f) => `${FNAME[f]}(${inner})`, "Http");
}

/* ---------------- part 2: one request through a stack ---------------- */

export interface Hop { depth: number; text: string; bad?: boolean }
export interface Trace {
  team: TeamId;
  stack: Feature[];
  hops: Hop[];
  logLines: string[];
  tokenFetches: number;
  httpCalls: number;
  status: number;
  totalMs: number;
}

/** The server: the first attempt gets 503 after 150 ms, later ones 200 after 120 ms. Backoff is 200 ms. */
export function simulate(team: TeamId, stack: Feature[]): Trace {
  const t: Trace = { team, stack: [...stack], hops: [], logLines: [], tokenFetches: 0, httpCalls: 0, status: 0, totalMs: 0 };
  const call = (i: number): { status: number; ms: number } => {
    if (i >= stack.length) {
      const n = ++t.httpCalls;
      const r = n === 1 ? { status: 503, ms: 150 } : { status: 200, ms: 120 };
      t.hops.push({ depth: i, text: `Http: attempt ${n} → ${r.status} in ${r.ms} ms`, bad: r.status >= 500 });
      return r;
    }
    const f = stack[i];
    if (f === "auth") {
      t.tokenFetches++;
      t.hops.push({ depth: i, text: `Auth: fetches token #${t.tokenFetches}, sets the header` });
      return call(i + 1);
    }
    if (f === "logging") {
      const r = call(i + 1);
      const line = `GET /v1/charges → ${r.status} in ${r.ms} ms`;
      t.logLines.push(line);
      t.hops.push({ depth: i, text: `Logging: writes "${line}"`, bad: r.status >= 500 });
      return r;
    }
    // retry: up to 3 attempts while the answer is a 5xx
    let r = call(i + 1);
    let ms = r.ms;
    for (let a = 1; a < 3 && r.status >= 500; a++) {
      t.hops.push({ depth: i, text: `Retry: got ${r.status}, waits 200 ms, tries again` });
      const again = call(i + 1);
      ms += 200 + again.ms;
      r = again;
    }
    return { status: r.status, ms };
  };
  const r = call(0);
  t.status = r.status;
  t.totalMs = r.ms;
  return t;
}

/** One line on why this order behaved as it did. */
export function explain(tr: Trace): string {
  const s = tr.stack;
  const parts: string[] = [];
  const li = s.indexOf("logging"), ri = s.indexOf("retry"), ai = s.indexOf("auth");
  if (ri < 0) parts.push("No Retry layer, so the 503 went straight back to the caller.");
  if (li >= 0 && ri >= 0) parts.push(li < ri
    ? "Logging is outside Retry, so it saw one call: one line, with the total time including the retry."
    : "Logging is inside Retry, so it saw every attempt: the failed one is in the log too.");
  if (ai >= 0 && ri >= 0) parts.push(ai > ri
    ? "Auth is inside Retry, so each attempt fetched a fresh token."
    : "Auth is outside Retry, so one token was reused for every attempt.");
  return parts.join(" ");
}

/* ---------------- step ---------------- */

/** Add a layer at its default slot, keeping the reader's order for the layers already there. */
function insert(cur: Feature[], f: Feature): Feature[] {
  const at = cur.findIndex((x) => CANON.indexOf(x) > CANON.indexOf(f));
  return at < 0 ? [...cur, f] : [...cur.slice(0, at), f, ...cur.slice(at)];
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "toggle": {
      const cur = st.teams[a.team];
      const next = cur.includes(a.feature) ? cur.filter((f) => f !== a.feature) : insert(cur, a.feature);
      const teams = { ...st.teams, [a.team]: next };
      return { ...st, teams, born: grow(st.born, teams), trace: null };
    }
    case "logEverywhere": {
      if (st.loggingEverywhere) return st;
      const c = counts(st);
      const teams = { ...st.teams };
      for (const t of TEAMS) if (!teams[t.id].includes("logging")) teams[t.id] = ["logging", ...teams[t.id]];
      return { ...st, teams, born: grow(st.born, teams), loggingEverywhere: true, before: { classes: c.classes, copies: c.copies }, trace: null };
    }
    case "select":
      return { ...st, selected: a.team, trace: null };
    case "move": {
      const fs = [...st.teams[st.selected]];
      const i = fs.indexOf(a.feature), j = i + a.dir;
      if (i < 0 || j < 0 || j >= fs.length) return st;
      [fs[i], fs[j]] = [fs[j], fs[i]];
      const teams = { ...st.teams, [st.selected]: fs };
      return { ...st, teams, born: grow(st.born, teams), trace: null };
    }
    case "send":
      return { ...st, trace: simulate(st.selected, st.teams[st.selected]) };
  }
}
