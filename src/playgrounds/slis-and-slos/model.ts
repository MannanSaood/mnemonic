// SLIs, SLOs and error budgets: a month of checkout traffic, hour by hour.
//
// After this, the reader can answer: "Given an SLO, how much failure can my service afford this
// month, which incidents spend it, and what happens when it runs out?"
// Core insight: the error budget is small and concrete (at 99.9% a month allows about 43 minutes
// of total failure at average traffic), the SLI decides which incidents count against it at all,
// and an agreed policy turns "budget gone" into a release freeze instead of an argument.
//
// The reader picks an SLI and an SLO target, then places incidents and releases on the 30 days.
// The model replays the month hour by hour, draws the remaining budget, and applies the policy:
// once the budget is spent, later releases are frozen and cost nothing.
// Pure and deterministic: traffic follows a fixed daily curve; counts may be fractional.

export const DAYS = 30;
export const HOURS = DAYS * 24;
/** Average requests per hour. The daily curve peaks at 14:00 and bottoms out at night. */
export const AVG_PER_HOUR = 100_000;
export const SWING = 0.6;
/** Baseline: share of requests that fail, share slower than 300 ms, and their latencies. */
export const BASE_ERR = 0.0002;
export const BASE_SLOW = 0.003;
export const FAST_MS = 120;
export const BASE_SLOW_MS = 400;
export const EVENT_SLOW_MS = 700;
/** Thresholds for the two latency SLIs. */
export const LATENCY_THRESHOLD_MS = 300;
export const MEAN_THRESHOLD_MS = 250;

export type Sli = "availability" | "latency" | "mean";
export const SLIS: Sli[] = ["availability", "latency", "mean"];
export const SLI_NAME: Record<Sli, string> = {
  availability: "Requests that succeed",
  latency: "Requests under 300 ms",
  mean: "Hours with mean latency under 250 ms",
};
export const SLI_RULE: Record<Sli, string> = {
  availability: "good = non-5xx responses · valid = all requests",
  latency: "good = answered in under 300 ms · valid = all requests",
  mean: "good = hours whose average latency is under 250 ms · valid = all hours",
};

export const SLOS = [99, 99.5, 99.9, 99.95, 99.99] as const;
export type Slo = (typeof SLOS)[number];

export type Kind = "release" | "bad" | "zone" | "slow";
export const KINDS: Kind[] = ["release", "bad", "zone", "slow"];
export const KIND_NAME: Record<Kind, string> = {
  release: "Release",
  bad: "Bad release",
  zone: "Zone outage",
  slow: "Slow dependency",
};
export const KIND_SHORT: Record<Kind, string> = { release: "R", bad: "B", zone: "Z", slow: "S" };
export const KIND_NOTE: Record<Kind, string> = {
  release: "1% of requests fail for 15 minutes while it rolls out",
  bad: "every request fails for 20 minutes until it is rolled back",
  zone: "30% of requests fail for an hour",
  slow: "20% of requests take 700 ms for 8 hours; none fail",
};
/** Releases are changes the team chooses to make, so the policy can freeze them. */
export const FREEZABLE: Record<Kind, boolean> = { release: true, bad: true, zone: false, slow: false };

export type When = "peak" | "quiet";
export interface Ev { id: number; kind: Kind; day: number; when: When }

/** First hour of the day the event starts in. */
export function startHour(e: Ev): number {
  const h = e.when === "peak" ? (e.kind === "slow" ? 10 : 14) : (e.kind === "slow" ? 0 : 3);
  return (e.day - 1) * 24 + h;
}

/** Requests in hour h of the month. */
export function traffic(h: number): number {
  const hod = (h % 24) + 0.5;
  return AVG_PER_HOUR * (1 + SWING * Math.cos((2 * Math.PI * (hod - 14)) / 24));
}

interface Effect { err: number; slow: number }
/** What an event does to each hour it touches: extra failed requests and extra slow requests. */
function effect(e: Ev, h: number): Effect {
  const s = startHour(e);
  const R = traffic(h);
  switch (e.kind) {
    case "release": return h === s ? { err: R * 0.01 * (15 / 60), slow: 0 } : { err: 0, slow: 0 };
    case "bad": return h === s ? { err: R * (20 / 60), slow: 0 } : { err: 0, slow: 0 };
    case "zone": return h === s ? { err: R * 0.3, slow: 0 } : { err: 0, slow: 0 };
    case "slow": return h >= s && h < s + 8 ? { err: 0, slow: R * 0.2 } : { err: 0, slow: 0 };
  }
}
const touches = (e: Ev, h: number) => {
  const s = startHour(e);
  return e.kind === "slow" ? h >= s && h < s + 8 : h === s;
};

export type Policy = "green" | "amber" | "red";
export const POLICY_NAME: Record<Policy, string> = { green: "Healthy", amber: "At risk", red: "Exhausted" };
export const POLICY_RULE: Record<Policy, string> = {
  green: "More than half the budget left. Ship as planned.",
  amber: "Less than half left. Releases need a second reviewer and a slower canary; reliability bugs jump the queue.",
  red: "Budget spent. Feature releases are frozen until the window has budget again; only reliability fixes ship.",
};
export const policyOf = (remaining: number): Policy => (remaining <= 0 ? "red" : remaining < 0.5 ? "amber" : "green");

export interface EventCost { id: number; bad: number; share: number; frozen: boolean }
export interface Result {
  sli: Sli;
  slo: Slo;
  /** Valid events in the month, and how many bad ones the SLO allows. */
  valid: number;
  budget: number;
  /** Bad events in the month, and the SLI's value for the month (0..1). */
  bad: number;
  value: number;
  /** Remaining budget (1 = untouched, 0 = spent, negative = overspent) at the end of each hour. */
  remaining: number[];
  /** Hour in which the budget first ran out, and in which it first fell below half. */
  exhaustedAt: number | null;
  amberAt: number | null;
  costs: EventCost[];
  shipped: number;
  frozen: number;
  /** The budget as minutes of total failure at average traffic (or hours, for the hourly SLI). */
  budgetMinutes: number;
}

/** Replay the month for one SLI and SLO, applying the policy. Pure. */
export function evaluate(events: Ev[], sli: Sli, slo: Slo): Result {
  const target = slo / 100;
  let valid = 0;
  for (let h = 0; h < HOURS; h++) valid += sli === "mean" ? 1 : traffic(h);
  const budget = (1 - target) * valid;
  const frozenIds = new Set<number>();
  const badById = new Map<number, number>(events.map((e) => [e.id, 0]));
  const remaining: number[] = [];
  let spent = 0;
  let exhaustedAt: number | null = null, amberAt: number | null = null;
  const sorted = [...events].sort((a, b) => startHour(a) - startHour(b) || a.id - b.id);

  for (let h = 0; h < HOURS; h++) {
    // The policy decides at the start of the hour, from the budget left so far.
    const left = budget > 0 ? 1 - spent / budget : -Infinity;
    for (const e of sorted) if (FREEZABLE[e.kind] && startHour(e) === h && left <= 0) frozenIds.add(e.id);
    const active = sorted.filter((e) => !frozenIds.has(e.id) && touches(e, h));
    const R = traffic(h);
    let err = R * BASE_ERR, slow = R * BASE_SLOW, eventSlow = 0;
    const per: [number, Effect][] = active.map((e) => [e.id, effect(e, h)]);
    for (const [, f] of per) { err += f.err; slow += f.slow; eventSlow += f.slow; }
    let badHour: number;
    if (sli === "availability") {
      badHour = Math.min(err, R);
      for (const [id, f] of per) badById.set(id, badById.get(id)! + f.err);
    } else if (sli === "latency") {
      badHour = Math.min(slow, R);
      for (const [id, f] of per) badById.set(id, badById.get(id)! + f.slow);
    } else {
      const s = Math.min(1, eventSlow / R);
      const mean = (1 - BASE_SLOW - s) * FAST_MS + BASE_SLOW * BASE_SLOW_MS + s * EVENT_SLOW_MS;
      badHour = mean >= MEAN_THRESHOLD_MS ? 1 : 0;
      if (badHour) for (const [id, f] of per) if (f.slow > 0) badById.set(id, badById.get(id)! + 1 / per.filter(([, g]) => g.slow > 0).length);
    }
    spent += badHour;
    const r = budget > 0 ? 1 - spent / budget : spent > 0 ? -1 : 1;
    remaining.push(r);
    if (amberAt === null && r < 0.5) amberAt = h;
    if (exhaustedAt === null && r <= 0) exhaustedAt = h;
  }

  const costs = events.map((e) => {
    const bad = frozenIds.has(e.id) ? 0 : badById.get(e.id) ?? 0;
    return { id: e.id, bad, share: budget > 0 ? bad / budget : 0, frozen: frozenIds.has(e.id) };
  });
  const releases = events.filter((e) => FREEZABLE[e.kind]);
  return {
    sli, slo, valid, budget, bad: spent, value: valid > 0 ? 1 - spent / valid : 1, remaining, exhaustedAt, amberAt, costs,
    shipped: releases.filter((e) => !frozenIds.has(e.id)).length,
    frozen: releases.filter((e) => frozenIds.has(e.id)).length,
    budgetMinutes: sli === "mean" ? budget * 60 : (1 - target) * HOURS * 60,
  };
}

/* ---------------- the reader's state ---------------- */

export type Tool = Kind | "remove";

export const CHALLENGES = [
  { id: "one", text: "Spend the whole month's budget with one incident." },
  { id: "freeze", text: "Get a release frozen by the error budget policy." },
  { id: "hidden", text: "Find an SLI that stays at 100% while a fifth of checkouts take 700 ms for 8 hours." },
  { id: "survive", text: "Ship a bad release and still end the month within an availability SLO." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  sli: Sli;
  slo: Slo;
  tool: Tool;
  when: When;
  events: Ev[];
  seq: number;
  prediction: string | null;
  done: Partial<Record<ChallengeId, boolean>>;
}

export type Action =
  | { type: "sli"; sli: Sli }
  | { type: "slo"; slo: Slo }
  | { type: "tool"; tool: Tool }
  | { type: "when"; when: When }
  | { type: "day"; day: number }
  | { type: "clear" }
  | { type: "predict"; value: string }
  | { type: "reset" };

/** The team's usual plan: a release every Tuesday and Thursday afternoon. */
export const RELEASE_DAYS = [2, 4, 9, 11, 16, 18, 23, 25, 30];

export function init(): State {
  const events: Ev[] = RELEASE_DAYS.map((day, i) => ({ id: i + 1, kind: "release", day, when: "peak" }));
  return { sli: "availability", slo: 99.9, tool: "bad", when: "peak", events, seq: events.length + 1, prediction: null, done: {} };
}

function progress(s: State): State {
  const r = evaluate(s.events, s.sli, s.slo);
  const done = { ...s.done };
  const ev = (id: number) => s.events.find((e) => e.id === id)!;
  if (r.costs.some((c) => c.share >= 1 && ev(c.id).kind !== "release")) done.one = true;
  if (r.frozen > 0) done.freeze = true;
  if (s.sli === "mean" && s.events.some((e) => e.kind === "slow") && r.bad === 0) done.hidden = true;
  if (s.sli === "availability" && r.costs.some((c) => !c.frozen && ev(c.id).kind === "bad") && r.remaining[HOURS - 1] > 0) done.survive = true;
  return { ...s, done };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return s.prediction ? s : { ...s, prediction: a.value };
    case "tool": return { ...s, tool: a.tool };
    case "when": return { ...s, when: a.when };
    case "sli": return progress({ ...s, sli: a.sli });
    case "slo": return progress({ ...s, slo: a.slo });
    case "clear": return { ...s, events: [] };
    case "day": {
      if (a.day < 1 || a.day > DAYS) return s;
      if (s.tool === "remove") {
        const onDay = s.events.filter((e) => e.day === a.day);
        if (!onDay.length) return s;
        const last = onDay[onDay.length - 1];
        return progress({ ...s, events: s.events.filter((e) => e.id !== last.id) });
      }
      const ev: Ev = { id: s.seq, kind: s.tool, day: a.day, when: s.when };
      return progress({ ...s, events: [...s.events, ev], seq: s.seq + 1 });
    }
  }
}

/** Day (1-based) for an hour of the month. */
export const dayOf = (h: number) => Math.floor(h / 24) + 1;
