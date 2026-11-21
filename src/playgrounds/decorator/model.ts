// Decorator playground: a stack of HTTP middleware around one orders handler, and a fixed burst
// of real-looking traffic replayed through it every time the reader changes the stack.
//
// Purpose. After this, the reader can answer: "Why does the order I wrap middleware in decide
// which requests get logged, rejected, throttled or served from cache?" Each wrapper only sees
// what the wrappers outside it let through, and a wrapper that answers early (a 401, a 429, a
// cache hit) means nothing inside it runs.
//
// The four wrappers never change. Only their order does, and with it the outcome: the starting
// order leaks a customer's orders to a request without a token and keeps 2 of 9 requests in
// the access log.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const LAYERS = ["logging", "ratelimit", "auth", "cache"] as const;
export type LayerId = (typeof LAYERS)[number];
export const LAYER_NAME: Record<LayerId, string> = { logging: "Logging", ratelimit: "RateLimit", auth: "Auth", cache: "Cache" };
export const LAYER_JOB: Record<LayerId, string> = {
  logging: "Writes one access-log line with the status, on the way out.",
  ratelimit: "Allows 3 requests per client per minute. Answers 429 after that.",
  auth: "Checks the token with the identity service. Answers 401 without one.",
  cache: "Serves a stored response if it has one. Keys on user and path if it knows the user, else on the path alone.",
};

/** Requests allowed per client before RateLimit answers 429. */
export const LIMIT = 3;

export interface Req { id: number; client: string; token: boolean; path: string; label: string }

/** The traffic: the same burst every run, so runs can be compared. */
export const TRAFFIC: Req[] = [
  { id: 1, client: "ana", token: true, path: "/orders/42", label: "Ana opens her orders" },
  { id: 2, client: "ana", token: true, path: "/orders/42", label: "Ana refreshes" },
  { id: 3, client: "anon", token: false, path: "/orders/42", label: "No token, asks for order 42" },
  ...[1, 2, 3, 4, 5].map((p, i) => ({ id: 4 + i, client: "scraper", token: false, path: `/orders?page=${p}`, label: `Scraper, no token, page ${p}` })),
  { id: 9, client: "ben", token: true, path: "/orders/77", label: "Ben opens his orders" },
];

/** What happened at one layer (or at the handler) for one request. */
export type Cell =
  | "pass"   // went through on the way in
  | "logged" // Logging: passed, and wrote the line on the way out
  | "stop"   // answered early (401 or 429); nothing inside ran
  | "hit"    // Cache answered from memory; nothing inside ran
  | "miss"   // Cache had nothing, passed it on, stored the answer
  | "run"    // the handler ran (a database call)
  | "skip";  // never reached

export interface Outcome {
  req: Req;
  status: 200 | 401 | 429;
  /** One cell per layer in stack order, then one for the handler. */
  cells: Cell[];
  /** Whose orders the response contains, if any. */
  servedOrdersOf: string | null;
  /** A request without a token got order data. */
  leak: boolean;
  logged: boolean;
  dbCall: boolean;
  authCheck: boolean;
  /** One short sentence: what the client saw and why. */
  text: string;
}

export interface Metrics { total: number; leaks: number; logged: number; throttled: number; dbCalls: number; authChecks: number; refreshCached: boolean }

export interface Run { stack: LayerId[]; outcomes: Outcome[]; metrics: Metrics }

export type Guess = "401" | "leak" | "429";

export interface State {
  /** Outermost first. The handler is always innermost. */
  stack: LayerId[];
  guess: Guess | null;
  run: Run | null;
  prev: Run | null;
  /** The first run, on the starting stack, for the reader's before/after numbers. */
  baseline: Run | null;
  /** Changes made to the stack after the first run. */
  changes: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "send" }
  | { type: "move"; layer: LayerId; dir: -1 | 1 }
  | { type: "remove"; layer: LayerId }
  | { type: "add"; layer: LayerId }
  | { type: "reset" };

export const START: LayerId[] = ["cache", "auth", "logging"];
export const RECOMMENDED: LayerId[] = ["logging", "ratelimit", "auth", "cache"];

export function init(): State {
  return { stack: [...START], guess: null, run: null, prev: null, baseline: null, changes: 0 };
}

/* ---------------- the simulation ---------------- */

/** Replays the traffic through a stack. Pure: the cache and rate counters live only for this run. */
export function simulate(stack: LayerId[]): Run {
  const cache = new Map<string, string>(); // key -> whose orders the stored body holds
  const counts = new Map<string, number>();
  const outcomes = TRAFFIC.map((req) => {
    const cells: Cell[] = stack.map(() => "skip");
    let user: string | null = null;
    let authCheck = false, dbCall = false;
    let status: Outcome["status"] = 200;
    let served: string | null = null;
    let why = "";

    // Walk inward until a layer answers or the handler runs.
    let i = 0;
    for (; i < stack.length; i++) {
      const layer = stack[i];
      if (layer === "logging") { cells[i] = "logged"; continue; }
      if (layer === "ratelimit") {
        const n = (counts.get(req.client) ?? 0) + 1;
        counts.set(req.client, n);
        if (n > LIMIT) { cells[i] = "stop"; status = 429; why = `RateLimit: request ${n} from ${req.client} this minute.`; break; }
        cells[i] = "pass"; continue;
      }
      if (layer === "auth") {
        authCheck = true;
        if (!req.token) { cells[i] = "stop"; status = 401; why = "Auth: no token."; break; }
        user = req.client; cells[i] = "pass"; continue;
      }
      // cache: before Auth has run there is no user, so the key is the path alone
      const key = user ? `${user}:${req.path}` : req.path;
      const hit = cache.get(key);
      if (hit !== undefined) {
        cells[i] = "hit"; served = hit;
        why = user ? "Cache hit on this user's own entry." : `Cache hit on the path alone: Cache runs before anyone checked who is asking.`;
        break;
      }
      cells[i] = "miss";
    }
    const reachedHandler = i === stack.length;
    if (reachedHandler) {
      dbCall = true;
      // The handler trusts the stack: it renders the orders the path asks for.
      served = req.path.startsWith("/orders/") ? (req.path === "/orders/42" ? "ana" : "ben") : "list";
      why = req.token ? "Handler ran: one database call." : "Handler ran with no user: nothing outside it checked the token.";
      // Store on the way out, in every Cache layer that missed.
      stack.forEach((l, j) => {
        if (l !== "cache" || cells[j] !== "miss") return;
        const authBefore = stack.slice(0, j).includes("auth");
        cache.set(authBefore && user ? `${user}:${req.path}` : req.path, served!);
      });
    }
    const leak = !req.token && served !== null;
    const logged = cells.includes("logged");
    const statusText = status === 200 ? (served === null ? "200" : leak ? "200 with order data" : "200") : String(status);
    const text = `${statusText}. ${why}`;
    return {
      req, status, cells: [...cells, reachedHandler ? "run" : "skip"],
      servedOrdersOf: served, leak, logged, dbCall, authCheck, text,
    } satisfies Outcome;
  });
  const metrics: Metrics = {
    total: outcomes.length,
    leaks: outcomes.filter((o) => o.leak).length,
    logged: outcomes.filter((o) => o.logged).length,
    throttled: outcomes.filter((o) => o.status === 429).length,
    dbCalls: outcomes.filter((o) => o.dbCall).length,
    authChecks: outcomes.filter((o) => o.authCheck).length,
    refreshCached: outcomes[1].cells.includes("hit"),
  };
  return { stack: [...stack], outcomes, metrics };
}

/* ---------------- goals ---------------- */

export interface Goal { id: string; text: string; met: (m: Metrics) => boolean }
export const GOALS: Goal[] = [
  { id: "leak", text: "No request without a token gets order data.", met: (m) => m.leaks === 0 },
  { id: "log", text: "Every request is in the access log, rejected ones too.", met: (m) => m.logged === m.total },
  { id: "throttle", text: "The scraper gets 429 Too Many Requests.", met: (m) => m.throttled > 0 },
  { id: "cache", text: "Ana's refresh comes from the cache, not the database.", met: (m) => m.refreshCached },
];
export const allGoalsMet = (m: Metrics) => GOALS.every((g) => g.met(m));

/** Request ids whose status or served data changed between two runs. */
export function changed(a: Run | null, b: Run | null): number[] {
  if (!a || !b) return [];
  return b.outcomes.filter((o, i) => o.status !== a.outcomes[i].status || o.servedOrdersOf !== a.outcomes[i].servedOrdersOf).map((o) => o.req.id);
}

/** How many different stacks the wrappers can make: ordered, non-empty selections. */
export function stackCount(n: number): number {
  let total = 0;
  for (let k = 1; k <= n; k++) {
    let p = 1;
    for (let j = 0; j < k; j++) p *= n - j;
    total += p;
  }
  return total;
}

/* ---------------- step ---------------- */

function rerun(st: State, stack: LayerId[]): State {
  if (!st.run) return { ...st, stack };
  return { ...st, stack, prev: st.run, run: simulate(stack), changes: st.changes + 1 };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.run ? st : { ...st, guess: a.guess };
    case "send": {
      if (st.run) return st;
      const run = simulate(st.stack);
      return { ...st, run, baseline: run };
    }
    case "move": {
      const i = st.stack.indexOf(a.layer), j = i + a.dir;
      if (i < 0 || j < 0 || j >= st.stack.length) return st;
      const stack = [...st.stack];
      [stack[i], stack[j]] = [stack[j], stack[i]];
      return rerun(st, stack);
    }
    case "remove":
      if (!st.stack.includes(a.layer)) return st;
      return rerun(st, st.stack.filter((l) => l !== a.layer));
    case "add":
      // A new wrapper goes on the outside, as wrapping one more time would put it.
      if (st.stack.includes(a.layer)) return st;
      return rerun(st, [a.layer, ...st.stack]);
  }
}
