// Purpose. After this, the reader can answer: "Where in a request should each kind of failure be
// handled, and what goes wrong when a layer handles it in the wrong way?" Each error should be
// handled once, by the layer that can act on it: retry next to the call that can be repeated,
// add context on the way up, turn it into a message for the user only at the edge, never swallow.
//
// The model: POST /orders flows through four layers. The handler calls the order service; the
// service charges the card through the payment client (an external API) and then saves the order
// through the repository (a database). The reader picks a policy for each layer and injects a
// failure. The run is traced call by call, and three things are measured against the truth:
// what the customer was told, what the logs say (does the root cause survive?), and what really
// happened to the money (charges made, orders saved).
//
// Plain data + pure functions, so it can be tested without a browser.

export type Layer = "handler" | "service" | "payment" | "repo";
export type Policy = "swallow" | "log" | "wrap" | "retry" | "message";
export type Fault = "blip" | "down" | "declined" | "dbTimeout";

export const LAYERS: { id: Layer; name: string; calls: string; ctx: string }[] = [
  { id: "handler", name: "Handler", calls: "POST /orders", ctx: "POST /orders" },
  { id: "service", name: "Order service", calls: "charge, then save", ctx: "place order 1042" },
  { id: "payment", name: "Payment client", calls: "payment provider API", ctx: "charge order 1042" },
  { id: "repo", name: "Repository", calls: "orders database", ctx: "save order 1042" },
];
export const LAYER = Object.fromEntries(LAYERS.map((l) => [l.id, l])) as Record<Layer, (typeof LAYERS)[number]>;

export const POLICIES: { id: Policy; label: string; code: string }[] = [
  { id: "swallow", label: "Swallow", code: "catch, carry on as if it worked" },
  { id: "log", label: "Log, continue", code: "log the error, carry on" },
  { id: "wrap", label: "Wrap, return", code: "add context, pass it up" },
  { id: "retry", label: "Retry", code: "try again if transient (3 tries), else pass up" },
  { id: "message", label: "User message", code: "turn it into text for the customer" },
];
export const POLICY = Object.fromEntries(POLICIES.map((p) => [p.id, p])) as Record<Policy, (typeof POLICIES)[number]>;

export const FAULTS: { id: Fault; label: string; detail: string; transient: boolean }[] = [
  { id: "blip", label: "Provider blip", detail: "The payment API returns one 503, then recovers.", transient: true },
  { id: "down", label: "Provider down", detail: "The payment API returns 503 on every call.", transient: false },
  { id: "declined", label: "Card declined", detail: "The payment API answers 402: the card is declined.", transient: false },
  { id: "dbTimeout", label: "DB timeout", detail: "The card is charged, then the first database write times out.", transient: true },
];
export const FAULT = Object.fromEntries(FAULTS.map((f) => [f.id, f])) as Record<Fault, (typeof FAULTS)[number]>;

/** The raw messages the outside world produces. The root cause is this text. */
export const ROOT: Record<Fault, string> = {
  blip: "POST /v1/charges: 503 Service Unavailable",
  down: "POST /v1/charges: 503 Service Unavailable",
  declined: "POST /v1/charges: 402 card_declined",
  dbTimeout: "INSERT INTO orders: timeout after 5s",
};

type Kind = "unavailable" | "declined" | "timeout" | "text";
interface Err { kind: Kind; chain: string[] }
const errText = (e: Err) => e.chain.join(": ");
const isTransient = (e: Err) => e.kind === "unavailable" || e.kind === "timeout";

export type Tone = "call" | "ok" | "fail" | "retry" | "log" | "wrap" | "swallow" | "message" | "respond";
export interface Trace { layer: Layer | "api" | "db"; tone: Tone; text: string }

export interface Run {
  fault: Fault;
  status: number;
  shown: string;
  logs: string[];
  trace: Trace[];
  apiCalls: number;
  charges: number;
  saves: number;
  /** what each layer did with the error that reached it */
  did: Partial<Record<Layer, Policy | "passed">>;
  verdict: Verdict;
}

export interface Verdict {
  /** what the customer was told matches what happened */
  honest: boolean;
  /** if something failed, the original cause is in the logs (a success needs no diagnosis) */
  causeLogged: boolean;
  /** the card was charged exactly as many times as an order was saved, at most once */
  moneyRight: boolean;
  /** a transient fault was absorbed and the order went through */
  recovered: boolean | null;
  problems: string[];
}

export type Policies = Record<Layer, Policy>;

interface World {
  fault: Fault;
  apiCalls: number;
  charges: number;
  dbCalls: number;
  saves: number;
  logs: string[];
  trace: Trace[];
  did: Partial<Record<Layer, Policy | "passed">>;
}

/** One call to the payment API. */
function callApi(w: World): Err | null {
  w.apiCalls++;
  const fails = w.fault === "down" || w.fault === "declined" || (w.fault === "blip" && w.apiCalls === 1);
  if (!fails) {
    w.charges++;
    w.trace.push({ layer: "api", tone: "ok", text: "200 charged 89.00 EUR" });
    return null;
  }
  const kind: Kind = w.fault === "declined" ? "declined" : "unavailable";
  w.trace.push({ layer: "api", tone: "fail", text: ROOT[w.fault] });
  return { kind, chain: [ROOT[w.fault]] };
}

/** One write to the database. */
function callDb(w: World): Err | null {
  w.dbCalls++;
  if (w.fault === "dbTimeout" && w.dbCalls === 1) {
    w.trace.push({ layer: "db", tone: "fail", text: ROOT.dbTimeout });
    return { kind: "timeout", chain: [ROOT.dbTimeout] };
  }
  w.saves++;
  w.trace.push({ layer: "db", tone: "ok", text: "INSERT INTO orders: 1 row" });
  return null;
}

const userText = (e: Err): string =>
  e.kind === "declined" ? "Your card was declined. Try another card."
  : e.kind === "unavailable" ? "Payments are unavailable right now. Please try again shortly."
  : e.kind === "timeout" ? "We could not save your order. Please try again."
  : e.chain[0];

/**
 * Apply a layer's policy around an operation. Returns the error to pass up, or null when the
 * layer reports success upward (because it worked, or because the layer hid the failure).
 */
function guard(w: World, layer: Layer, policy: Policy, op: () => Err | null): Err | null {
  const ctx = LAYER[layer].ctx;
  let e = op();
  if (!e) return null;
  if (policy === "retry") {
    let tries = 1;
    while (e && isTransient(e) && tries < 3) {
      tries++;
      w.trace.push({ layer, tone: "retry", text: `transient, retry ${tries - 1} of 2 after a short backoff` });
      e = op();
    }
    if (!e) { w.did[layer] = "retry"; return null; }
    w.did[layer] = isTransient(e) ? "retry" : "passed";
    const wrapped = { ...e, chain: [ctx, ...e.chain] };
    w.trace.push({ layer, tone: "wrap", text: isTransient(e) ? `gave up after ${tries} tries, returns "${ctx}: …"` : `not transient, no retry; returns "${ctx}: …"` });
    return wrapped;
  }
  w.did[layer] = policy;
  switch (policy) {
    case "swallow":
      w.trace.push({ layer, tone: "swallow", text: "catches it and reports success" });
      return null;
    case "log": {
      const line = `ERROR ${layer}: ${ctx}: ${errText(e)}`;
      w.logs.push(line);
      w.trace.push({ layer, tone: "log", text: "logs it and reports success" });
      return null;
    }
    case "wrap":
      w.trace.push({ layer, tone: "wrap", text: `returns "${ctx}: …"` });
      return { ...e, chain: [ctx, ...e.chain] };
    case "message": {
      const msg = userText(e);
      w.trace.push({ layer, tone: "message", text: `replaces it with "${msg}"` });
      return { kind: "text", chain: [msg] };
    }
  }
  return e;
}

function placeOrder(w: World, p: Policies): Err | null {
  w.trace.push({ layer: "service", tone: "call", text: "charge the card" });
  const charged = guard(w, "payment", p.payment, () => callApi(w));
  if (charged) return charged;
  w.trace.push({ layer: "service", tone: "call", text: "save the order" });
  return guard(w, "repo", p.repo, () => callDb(w));
}

export function simulate(p: Policies, fault: Fault): Run {
  const w: World = { fault, apiCalls: 0, charges: 0, dbCalls: 0, saves: 0, logs: [], trace: [], did: {} };
  w.trace.push({ layer: "handler", tone: "call", text: "POST /orders from the customer" });

  // The handler's policy around the service; the service's policy around its own work.
  const serviceOp = () => guard(w, "service", p.service, () => placeOrder(w, p));
  let status = 201;
  let shown = "Order placed. Thank you!";
  let e = serviceOp();
  if (e) {
    const hp = p.handler;
    if (hp === "retry") {
      let tries = 1;
      while (e && isTransient(e) && tries < 3) {
        tries++;
        w.trace.push({ layer: "handler", tone: "retry", text: `retries the whole request (${tries - 1} of 2)` });
        e = serviceOp();
      }
      w.did.handler = "retry";
    } else {
      w.did.handler = hp;
    }
    if (e) {
      if (hp === "swallow") {
        w.trace.push({ layer: "handler", tone: "swallow", text: "ignores the error" });
      } else if (hp === "log") {
        w.logs.push(`ERROR handler: POST /orders: ${errText(e)}`);
        w.trace.push({ layer: "handler", tone: "log", text: "logs it, answers 201 anyway" });
      } else if (hp === "message") {
        status = e.kind === "declined" ? 402 : e.kind === "unavailable" ? 503 : 500;
        shown = userText(e);
        w.logs.push(`ERROR handler: POST /orders: ${errText(e)}`);
        w.trace.push({ layer: "handler", tone: "message", text: "logs the whole chain once, answers with a message for the customer" });
      } else {
        // wrap, or retry that gave up: the raw error goes to the customer
        status = 500;
        shown = `500 Internal Server Error: ${errText(e)}`;
        w.trace.push({ layer: "handler", tone: "wrap", text: "sends the raw error text to the customer" });
      }
    }
  }
  w.trace.push({ layer: "handler", tone: "respond", text: `${status} ${shown}` });
  return {
    fault, status, shown, logs: w.logs, trace: w.trace, apiCalls: w.apiCalls, charges: w.charges, saves: w.saves, did: w.did,
    verdict: judge(fault, status, w),
  };
}

function judge(fault: Fault, status: number, w: World): Verdict {
  const problems: string[] = [];
  const told = status < 300;
  const placed = w.saves > 0 && w.charges > 0;
  const honest = told ? placed && w.charges === 1 : w.saves === 0;
  if (told && w.saves > 0 && w.charges === 0) problems.push("The order was saved and will ship, but the card was never charged.");
  if (told && w.saves === 0) problems.push("The customer was told the order was placed. There is no order.");
  if (!told && w.saves > 0) problems.push("The customer saw an error, but the order exists. They will order again.");
  if (w.charges > 0 && w.saves === 0) problems.push(`The card was charged ${w.charges === 1 ? "once" : `${w.charges} times`} and there is no order.`);
  if (w.charges > 1 && w.saves > 0) problems.push(`The card was charged ${w.charges} times for one order.`);
  const moneyRight = w.charges === w.saves && w.charges <= 1 && !(w.saves > 0 && w.charges === 0);
  // Every fault fails at least one call. A clean recovery needs no diagnosis; anything else does.
  const causeLogged = (told && placed && w.charges === 1) || w.logs.some((l) => l.includes(ROOT[fault]));
  if (!causeLogged) problems.push(`No log line contains the root cause (${ROOT[fault]}).`);
  if (status >= 500 && w.trace.some((t) => t.tone === "respond" && t.text.includes(ROOT[fault]))) problems.push("The customer saw internal error text.");
  const recovered = FAULT[fault].transient ? told && placed && w.charges === 1 : null;
  if (recovered === false) problems.push("A transient fault failed the order. One retry would have saved it.");
  return { honest, causeLogged, moneyRight, recovered, problems };
}

export function score(v: Verdict): { passed: number; total: number } {
  const marks = [v.honest, v.causeLogged, v.moneyRight, ...(v.recovered === null ? [] : [v.recovered])];
  return { passed: marks.filter(Boolean).length, total: marks.length };
}

/* ---------------- state ---------------- */

export type PredictChoice = "error" | "placed" | "declined";

export interface State {
  policies: Policies;
  fault: Fault | null;
  last: Run | null;
  /** the current policies run against every fault, after "run all" */
  matrix: Run[] | null;
  runs: number;
  /** goals the reader has reached (see GOALS) */
  goals: GoalId[];
}

export type GoalId = "honestOutage" | "absorbBlip" | "noDoubleCharge" | "allPass";
export const GOALS: { id: GoalId; text: string }[] = [
  { id: "honestOutage", text: "Provider down: the customer gets a clear error, no unpaid order ships, the cause is in the logs." },
  { id: "absorbBlip", text: "Provider blip: the order goes through, charged once." },
  { id: "noDoubleCharge", text: "DB timeout: the order goes through, charged once." },
  { id: "allPass", text: "One set of policies passes every check against all four faults." },
];

export const START: Policies = { handler: "message", service: "wrap", payment: "log", repo: "wrap" };

export type Action =
  | { type: "policy"; layer: Layer; policy: Policy }
  | { type: "inject"; fault: Fault }
  | { type: "runAll" }
  | { type: "reset" };

export function init(): State {
  return { policies: { ...START }, fault: null, last: null, matrix: null, runs: 0, goals: [] };
}

const allPass = (r: Run) => { const s = score(r.verdict); return s.passed === s.total; };

function reached(goals: GoalId[], runs: Run[], matrix: Run[] | null): GoalId[] {
  const out = new Set(goals);
  for (const r of [...runs, ...(matrix ?? [])]) {
    if (r.fault === "down" && allPass(r)) out.add("honestOutage");
    if (r.fault === "blip" && allPass(r)) out.add("absorbBlip");
    if (r.fault === "dbTimeout" && allPass(r)) out.add("noDoubleCharge");
  }
  if (matrix && matrix.every(allPass)) out.add("allPass");
  return GOALS.map((g) => g.id).filter((g) => out.has(g));
}

export function runAll(p: Policies): Run[] {
  return FAULTS.map((f) => simulate(p, f.id));
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "policy": {
      const policies = { ...s.policies, [a.layer]: a.policy };
      const last = s.fault ? simulate(policies, s.fault) : null;
      const matrix = s.matrix ? runAll(policies) : null;
      return { ...s, policies, last, matrix, goals: reached(s.goals, last ? [last] : [], matrix) };
    }
    case "inject": {
      const last = simulate(s.policies, a.fault);
      return { ...s, fault: a.fault, last, runs: s.runs + 1, goals: reached(s.goals, [last], null) };
    }
    case "runAll": {
      const matrix = runAll(s.policies);
      return { ...s, matrix, runs: s.runs + FAULTS.length, goals: reached(s.goals, [], matrix) };
    }
  }
}
