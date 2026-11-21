// Context playground: one checkout request as a tree of contexts and goroutines. The reader
// picks what goes wrong (a backend error, a client that hangs up, a tight deadline), drags time,
// and watches cancellation flow down the tree: which Done channels close, which goroutines stop,
// which keep burning because they ignore ctx, and which keep running on purpose.
//
// Purpose. After this, the reader can answer: "When a context is cancelled, which goroutines
// actually stop?" Only the ones below it in the tree that check Done (or pass ctx to calls that
// do). Cancel flows down, never up. A goroutine that ignores ctx keeps running, and if the
// handler waits for it (errgroup.Wait), the response waits too. context.Background() cuts a
// goroutine out of the tree; context.WithoutCancel does it on purpose.
//
// Plain state + a pure simulation over time, so it can be tested without a browser.

export type Scenario = "pricingError" | "clientGone" | "none";
export const SCENARIOS: { value: Scenario; label: string; note: string }[] = [
  { value: "pricingError", label: "pricing fails at 60 ms", note: "pricing.Quote returns an error after 60 ms" },
  { value: "clientGone", label: "client hangs up at 100 ms", note: "the browser tab is closed after 100 ms" },
  { value: "none", label: "nothing fails", note: "every backend answers; only the deadline can cut work short" },
];

export const ERROR_AT = 60;
export const GONE_AT = 100;
export const AUDIT_MS = 80;
/** How often the fixed fraud loop checks ctx.Err(): every 1,000 rows, about 5 ms. */
export const CHECK_EVERY = 5;
export const END = 600;
export const DEADLINES = [100, 150, 200, 250, 300, 400, 500] as const;

export interface Config { scenario: Scenario; deadline: number; fraudChecks: boolean; recsUsesCtx: boolean }
export const START: Config = { scenario: "pricingError", deadline: 300, fraudChecks: false, recsUsesCtx: false };

export type NodeId = "req" | "handler" | "group" | "inventory" | "pricing" | "fraud" | "recs" | "audit";
export type EndReason = "done" | "failed" | "stopped";

export interface CtxNode {
  id: NodeId; kind: "ctx"; parent: NodeId | null; code: string;
  /** When Done closes, or null if never. */
  doneAt: number | null; cause: string | null;
}
export interface WorkNode {
  id: NodeId; kind: "work"; parent: NodeId | null; code: string; job: string;
  /** Does it check ctx.Done / pass ctx to calls that do? */
  checks: boolean;
  /** Runs on after its parent is cancelled on purpose (WithoutCancel). */
  detached: boolean;
  start: number; end: number; reason: EndReason;
  /** When its result stopped mattering: its ctx closed, or the response went out. null if never. */
  uselessAt: number | null;
  /** Work done after uselessAt. */
  wasted: number;
}
export type Node = CtxNode | WorkNode;

export interface Outcome {
  nodes: Node[];
  respondAt: number;
  status: 200 | 499 | 500 | 504;
  statusText: string;
  wasted: number;
  /** Goroutines still running when the response went out, other than the deliberate audit write. */
  runningAtResponse: NodeId[];
}

const WORK = { inventory: 180, pricing: 120, fraud: 250, recs: 500 };

/** Simulates one request under a config. Pure. */
export function simulate(c: Config): Outcome {
  const errAt = c.scenario === "pricingError" ? ERROR_AT : Infinity;
  const goneAt = c.scenario === "clientGone" ? GONE_AT : Infinity;
  // Before the handler returns, the group's ctx closes at the first of: client gone, deadline, error.
  const groupCancel = Math.min(goneAt, c.deadline, errAt);
  const member = (work: number, checks: boolean, failsAt = Infinity) => {
    if (failsAt <= work && failsAt <= groupCancel) return { end: failsAt, reason: "failed" as EndReason };
    if (work <= groupCancel) return { end: work, reason: "done" as EndReason };
    // Ignoring ctx: it runs to the end, cancelled or not.
    if (!checks) return { end: work, reason: "done" as EndReason };
    return { end: groupCancel, reason: "stopped" as EndReason };
  };
  const inv = member(WORK.inventory, true);
  const pri = member(WORK.pricing, true, errAt);
  let fra = member(WORK.fraud, c.fraudChecks);
  // The fixed loop only notices at its next check, up to CHECK_EVERY ms later.
  if (fra.reason === "stopped") fra = { end: Math.min(WORK.fraud, groupCancel + CHECK_EVERY), reason: "stopped" };
  // errgroup.Wait returns when every function passed to g.Go has returned.
  const respondAt = Math.max(inv.end, pri.end, fra.end);
  // The handler's own ctx closes at the first of: parent, deadline, or defer cancel() on return.
  const handlerDone = Math.min(goneAt, c.deadline, respondAt);
  const handlerCause = handlerDone === goneAt ? "parent: client disconnected" : handlerDone === c.deadline ? "deadline exceeded" : "cancel() on return";
  const groupDone = Math.min(groupCancel, respondAt);
  const groupCause = groupDone === goneAt || groupDone === c.deadline ? `parent: ${groupDone === goneAt ? "client disconnected" : "deadline exceeded"}` : groupDone === errAt ? "first error: pricing" : "Wait returned";
  const reqDone = Math.min(goneAt, respondAt);
  const reqCause = reqDone === goneAt ? "client disconnected" : "ServeHTTP returned";

  const recsEnd = c.recsUsesCtx ? Math.min(WORK.recs, handlerDone) : WORK.recs;
  const recsReason: EndReason = recsEnd < WORK.recs ? "stopped" : "done";

  let status: Outcome["status"], statusText: string;
  if (goneAt <= respondAt) { status = 499; statusText = "client gone: nothing to send to"; }
  else if (pri.reason === "failed") { status = 500; statusText = "500: pricing failed"; }
  else if ([inv, pri, fra].some((m) => m.reason === "stopped")) { status = 504; statusText = "504: deadline exceeded"; }
  else { status = 200; statusText = "200 OK"; }

  const work = (id: NodeId, parent: NodeId | null, code: string, job: string, checks: boolean, start: number, end: number, reason: EndReason, uselessAt: number | null, detached = false): WorkNode => ({
    id, kind: "work", parent, code, job, checks, detached, start, end, reason, uselessAt,
    wasted: uselessAt === null ? 0 : Math.max(0, end - Math.max(uselessAt, start)),
  });
  const memberUseless = groupDone < Infinity ? groupDone : null;
  const nodes: Node[] = [
    { id: "req", kind: "ctx", parent: null, code: "r.Context()", doneAt: reqDone, cause: reqCause },
    { id: "handler", kind: "ctx", parent: "req", code: `context.WithTimeout(ctx, ${c.deadline}ms)`, doneAt: handlerDone, cause: handlerCause },
    { id: "group", kind: "ctx", parent: "handler", code: "errgroup.WithContext(ctx)", doneAt: groupDone, cause: groupCause },
    work("inventory", "group", "inventory.Reserve(gctx, cart)", "HTTP call, passes gctx", true, 0, inv.end, inv.reason, inv.reason === "done" ? null : memberUseless),
    work("pricing", "group", "pricing.Quote(gctx, cart)", "HTTP call, passes gctx", true, 0, pri.end, pri.reason, pri.reason === "done" ? null : memberUseless),
    work("fraud", "group", c.fraudChecks ? "fraud.Score(gctx, cart)" : "fraud.Score(cart)", c.fraudChecks ? "CPU loop, checks gctx.Err() every 1,000 rows" : "CPU loop over 50,000 rows, never looks at ctx", c.fraudChecks, 0, fra.end, fra.reason, fra.end > groupDone ? groupDone : (fra.reason === "stopped" ? groupDone : null)),
    work("recs", c.recsUsesCtx ? "handler" : null, c.recsUsesCtx ? "recs.Fetch(ctx, user)" : "recs.Fetch(context.Background(), user)", c.recsUsesCtx ? "optional extras, stops with the handler" : "optional extras, cut out of the tree", c.recsUsesCtx, 0, recsEnd, recsReason, recsEnd > respondAt ? respondAt : (recsReason === "stopped" ? handlerDone : null)),
    work("audit", "handler", "audit.Write(context.WithoutCancel(ctx), …)", "starts on return, must finish", false, respondAt, respondAt + AUDIT_MS, "done", null, true),
  ];
  // A member that stopped exactly at the cancel wasted nothing; one that ignored it wasted the rest.
  const wasted = nodes.reduce((s, n) => s + (n.kind === "work" ? n.wasted : 0), 0);
  const runningAtResponse = nodes.filter((n): n is WorkNode => n.kind === "work" && !n.detached && n.end > respondAt).map((n) => n.id);
  return { nodes, respondAt, status, statusText, wasted, runningAtResponse };
}

/* ---------------- state at one moment ---------------- */

export type WorkStatus = "running" | "done" | "failed" | "stopped" | "burning" | "detached" | "waiting";
export type CtxStatus = "open" | "closed";

export function ctxStatus(n: CtxNode, t: number): CtxStatus {
  return n.doneAt !== null && n.doneAt <= t ? "closed" : "open";
}

export function workStatus(n: WorkNode, t: number): WorkStatus {
  if (t < n.start) return "waiting";
  if (t >= n.end) return n.reason;
  if (n.detached) return "detached";
  if (n.uselessAt !== null && t >= n.uselessAt) return "burning";
  return "running";
}

/* ---------------- goals ---------------- */

export const GOALS: { id: string; text: string; met: (o: Outcome, c: Config) => boolean }[] = [
  { id: "fast", text: "When pricing fails, answer within 10 ms of the failure.", met: (o, c) => c.scenario === "pricingError" && o.respondAt <= ERROR_AT + 10 },
  { id: "clean", text: "Nothing but the audit write runs after the response.", met: (o) => o.runningAtResponse.length === 0 },
];

/* ---------------- step ---------------- */

export type Guess = "60" | "180" | "250";
export const ANSWER: Guess = "250";

export interface State {
  config: Config;
  time: number;
  guess: Guess | null;
  /** The reader has run a request at least once. */
  played: boolean;
  outcome: Outcome;
  /** The starting handler under the same scenario and deadline, for comparison. */
  baseline: Outcome;
  edits: number;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "scenario"; scenario: Scenario }
  | { type: "deadline"; deadline: number }
  | { type: "fixFraud"; on: boolean }
  | { type: "fixRecs"; on: boolean }
  | { type: "time"; t: number }
  | { type: "run" }
  | { type: "reset" };

function withConfig(st: State, c: Config, edit: boolean): State {
  return { ...st, config: c, outcome: simulate(c), baseline: simulate({ ...START, scenario: c.scenario, deadline: c.deadline }), edits: st.edits + (edit ? 1 : 0) };
}

export function init(): State {
  const o = simulate(START);
  return { config: { ...START }, time: 0, guess: null, played: false, outcome: o, baseline: o, edits: 0 };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.played ? st : { ...st, guess: a.guess };
    case "scenario":
      return withConfig(st, { ...st.config, scenario: a.scenario }, false);
    case "deadline":
      if (!(DEADLINES as readonly number[]).includes(a.deadline)) return st;
      return withConfig(st, { ...st.config, deadline: a.deadline }, false);
    case "fixFraud":
      return st.config.fraudChecks === a.on ? st : withConfig(st, { ...st.config, fraudChecks: a.on }, true);
    case "fixRecs":
      return st.config.recsUsesCtx === a.on ? st : withConfig(st, { ...st.config, recsUsesCtx: a.on }, true);
    case "time": {
      const t = Math.max(0, Math.min(END, Math.round(a.t)));
      return { ...st, time: t, played: st.played || t >= st.outcome.respondAt };
    }
    case "run":
      return { ...st, time: END, played: true };
  }
}
