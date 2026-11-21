// Alerting on SLOs: the same month of errors through three alerting rules.
//
// After this, the reader can answer: "Which alert rule pages me for the incidents that threaten
// my SLO, fast, and stays quiet for the ones that do not?"
// Core insight: alert on how fast the error budget is burning, not on the error rate itself. A
// threshold at the SLO pages for every blip; one burn-rate window misses slow leaks or keeps
// firing long after recovery; a long window for significance plus a short window to confirm the
// burn is still happening, at a few burn rates, catches big incidents in minutes, opens tickets
// for slow leaks, and stays quiet for blips. Low traffic breaks every ratio-based rule.
//
// Pure and deterministic: a seeded random generator makes the per-minute noise repeatable.

export const DAYS = 30;
export const MIN_PER_DAY = 1440;
export const MINUTES = DAYS * MIN_PER_DAY;
export const SLO = 0.999;
export const ALLOWED = 1 - SLO; // 0.1%

export type Traffic = "busy" | "quiet";
/** Requests per minute: a steady 1,000, or a service that sees 10 requests an hour. */
export const RPM: Record<Traffic, number> = { busy: 1000, quiet: 10 / 60 };
/** One-off failures that no one needs to wake up for. */
export const BASE_ERR: Record<Traffic, number> = { busy: 0.0001, quiet: 0.0005 };

export type Kind = "outage" | "partial" | "leak" | "blips";
export const KINDS: Kind[] = ["outage", "partial", "leak", "blips"];
export const KIND_NAME: Record<Kind, string> = { outage: "Total outage", partial: "Partial outage", leak: "Slow leak", blips: "Blips" };
/** Error rate and length (minutes) of each kind. Blips are four 5-minute bursts across the day. */
export const KIND_SPEC: Record<Kind, { rate: number; minutes: number; note: string }> = {
  outage: { rate: 1, minutes: 15, note: "every request fails for 15 minutes" },
  partial: { rate: 0.05, minutes: 120, note: "5% of requests fail for 2 hours" },
  leak: { rate: 0.003, minutes: 3 * MIN_PER_DAY, note: "0.3% of requests fail for 3 days" },
  blips: { rate: 0.02, minutes: 5, note: "four bursts of 2% errors for 5 minutes, spread over the day" },
};
/** An incident is significant when it would spend at least this share of the 30-day budget. */
export const SIGNIFICANT = 0.02;

export interface Incident { id: number; kind: Kind; day: number }

/** The bursts an incident is made of: [start minute, length, error rate]. */
export function bursts(i: Incident): [number, number, number][] {
  const d = (i.day - 1) * MIN_PER_DAY;
  const s = KIND_SPEC[i.kind];
  if (i.kind === "blips") return [2, 8, 14, 20].map((h) => [d + h * 60 + 7, s.minutes, s.rate]);
  return [[d + 10 * 60, s.minutes, s.rate]];
}
export const span = (i: Incident): [number, number] => {
  const b = bursts(i);
  return [b[0][0], b[b.length - 1][0] + b[b.length - 1][1]];
};
/** Share of the 30-day budget the incident spends at steady traffic. */
export const budgetShare = (i: Incident) => bursts(i).reduce((a, [, len, r]) => a + len * r, 0) / (MINUTES * ALLOWED);
export const significant = (i: Incident) => budgetShare(i) >= SIGNIFICANT;

/* ---------------- the month of data ---------------- */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(lambda: number, r: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    const g = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * g));
  }
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

export interface Series { req: Float64Array; err: Float64Array }

/** Requests and errors per minute for the month. */
export function series(incidents: Incident[], traffic: Traffic, seed = 7): Series {
  const r = rng(seed * 2 + (traffic === "busy" ? 0 : 1));
  const rate = new Float64Array(MINUTES).fill(BASE_ERR[traffic]);
  for (const i of incidents) for (const [s, len, p] of bursts(i)) for (let m = s; m < Math.min(MINUTES, s + len); m++) rate[m] = Math.min(1, rate[m] + p);
  const req = new Float64Array(MINUTES), err = new Float64Array(MINUTES);
  for (let m = 0; m < MINUTES; m++) {
    const p = rate[m];
    if (traffic === "busy") {
      const n = RPM.busy;
      req[m] = n;
      err[m] = p >= 1 ? n : Math.min(n, poisson(n * p, r));
    } else {
      const n = poisson(RPM.quiet, r);
      req[m] = n;
      let e = 0;
      for (let k = 0; k < n; k++) if (r() < p) e++;
      err[m] = e;
    }
  }
  return { req, err };
}

/* ---------------- alert rules ---------------- */

export type Window = 5 | 10 | 30 | 60 | 360 | 1440 | 4320;
export interface Cond { long: Window; short: Window | null; burn: number }
export interface Rule { id: StratId; name: string; page: Cond[]; ticket: Cond[] }
export type StratId = "threshold" | "single" | "multi";

export const SINGLE_WINDOWS: Window[] = [5, 60, 360];
export const SINGLE_BURNS = [2, 6, 14.4, 36];
export const windowName = (w: Window) => (w < 60 ? `${w} min` : w < 1440 ? `${w / 60} h` : `${w / 1440} d`);

export function rules(single: { window: Window; burn: number }): Rule[] {
  return [
    { id: "threshold", name: "Error rate over the SLO", page: [{ long: 10, short: null, burn: 1 }], ticket: [] },
    { id: "single", name: `Burn rate over ${single.burn}× for ${windowName(single.window)}`, page: [{ long: single.window, short: null, burn: single.burn }], ticket: [] },
    {
      id: "multi", name: "Multiwindow, multi-burn-rate",
      page: [{ long: 60, short: 5, burn: 14.4 }, { long: 360, short: 30, burn: 6 }],
      ticket: [{ long: 4320, short: 360, burn: 1 }],
    },
  ];
}
export const describeCond = (c: Cond) =>
  c.short ? `${windowName(c.long)} and ${windowName(c.short)} over ${c.burn}×` : c.burn === 1 ? `${windowName(c.long)} error rate ≥ 0.1%` : `${windowName(c.long)} over ${c.burn}×`;

export interface Episode { start: number; end: number; severity: "page" | "ticket"; falseAlarm: boolean }
export interface Detection { id: number; at: number | null; severity: "page" | "ticket" | null; spent: number; reset: number | null }
export interface StratResult {
  rule: Rule;
  episodes: Episode[];
  pages: number;
  tickets: number;
  falsePages: number;
  missed: number;
  detections: Detection[];
  /** Median minutes from incident start to first alert, over detected significant incidents. */
  medianDetect: number | null;
  /** Longest time an alert kept firing after its incident ended, in minutes. */
  worstReset: number | null;
}

/** Gaps shorter than this between firing minutes are one alert, as an alert manager would group them. */
const MERGE = 10;
/** How long after an incident ends an alert still counts as being about it. */
const GRACE = 360;

export function evaluate(incidents: Incident[], traffic: Traffic, single: { window: Window; burn: number }, seed = 7): StratResult[] {
  const s = series(incidents, traffic, seed);
  const R = new Float64Array(MINUTES + 1), E = new Float64Array(MINUTES + 1);
  for (let m = 0; m < MINUTES; m++) { R[m + 1] = R[m] + s.req[m]; E[m + 1] = E[m] + s.err[m]; }
  const ratio = (t: number, w: number) => {
    const a = Math.max(0, t + 1 - w);
    const n = R[t + 1] - R[a];
    return n > 0 ? (E[t + 1] - E[a]) / n : 0;
  };
  const holds = (c: Cond, t: number) => {
    const thr = c.burn * ALLOWED;
    const ok = (w: number) => (c.burn === 1 && !c.short ? ratio(t, w) >= thr : ratio(t, w) > thr);
    return ok(c.long) && (c.short === null || ok(c.short));
  };
  const sig = incidents.filter(significant).map((i) => ({ i, sp: span(i) }));
  const about = (e: { start: number; end: number }) => sig.filter(({ sp }) => e.start <= sp[1] + GRACE && e.end >= sp[0]);

  return rules(single).map((rule) => {
    const episodes: Episode[] = [];
    for (const severity of ["page", "ticket"] as const) {
      const conds = severity === "page" ? rule.page : rule.ticket;
      if (!conds.length) continue;
      let open: { start: number; end: number } | null = null;
      for (let t = 0; t < MINUTES; t++) {
        if (conds.some((c) => holds(c, t))) {
          if (open && t - open.end <= MERGE) open.end = t + 1;
          else { if (open) episodes.push({ ...open, severity, falseAlarm: false }); open = { start: t, end: t + 1 }; }
        }
      }
      if (open) episodes.push({ ...open, severity, falseAlarm: false });
    }
    // Inhibition: a ticket that overlaps a page from the same rule is not sent; the page covers it.
    const pagesOnly = episodes.filter((e) => e.severity === "page");
    const sent = episodes.filter((e) => e.severity === "page" || !pagesOnly.some((p) => e.start <= p.end && e.end >= p.start));
    episodes.length = 0;
    episodes.push(...sent);
    for (const e of episodes) e.falseAlarm = about(e).length === 0;
    episodes.sort((a, b) => a.start - b.start);
    const detections: Detection[] = sig.map(({ i, sp }) => {
      const hits = episodes.filter((e) => e.start <= sp[1] + GRACE && e.end > sp[0]);
      if (!hits.length) return { id: i.id, at: null, severity: null, spent: budgetShare(i), reset: null };
      const pageHits = hits.filter((h) => h.severity === "page");
      const use = pageHits.length ? pageHits : hits;
      const at = Math.min(...use.map((h) => Math.max(h.start, sp[0]))) - sp[0];
      const len = sp[1] - sp[0];
      const reset = Math.max(...use.map((h) => h.end)) - sp[1];
      return { id: i.id, at, severity: pageHits.length ? "page" : "ticket", spent: budgetShare(i) * Math.min(1, at / len), reset: Math.max(0, reset) };
    });
    const found = detections.filter((d) => d.at !== null).map((d) => d.at!).sort((a, b) => a - b);
    const resets = detections.filter((d) => d.reset !== null).map((d) => d.reset!);
    return {
      rule, episodes,
      pages: episodes.filter((e) => e.severity === "page").length,
      tickets: episodes.filter((e) => e.severity === "ticket").length,
      falsePages: episodes.filter((e) => e.severity === "page" && e.falseAlarm).length,
      missed: detections.filter((d) => d.at === null).length,
      detections,
      medianDetect: found.length ? found[Math.floor((found.length - 1) / 2)] : null,
      worstReset: resets.length ? Math.max(...resets) : null,
    };
  });
}

/** Error ratio per hour, for the chart. */
export function hourly(incidents: Incident[], traffic: Traffic, seed = 7): { ratio: number; errors: number }[] {
  const s = series(incidents, traffic, seed);
  const out: { ratio: number; errors: number }[] = [];
  for (let h = 0; h < DAYS * 24; h++) {
    let n = 0, e = 0;
    for (let m = h * 60; m < h * 60 + 60; m++) { n += s.req[m]; e += s.err[m]; }
    out.push({ ratio: n > 0 ? e / n : 0, errors: e });
  }
  return out;
}

/* ---------------- the reader's state ---------------- */

export type Tool = Kind | "remove";

export const DEFAULT_INCIDENTS: Omit<Incident, "id">[] = [
  { kind: "blips", day: 2 }, { kind: "outage", day: 4 }, { kind: "blips", day: 7 }, { kind: "partial", day: 10 },
  { kind: "blips", day: 13 }, { kind: "leak", day: 16 }, { kind: "blips", day: 22 }, { kind: "blips", day: 26 },
];

export const CHALLENGES = [
  { id: "noisy", text: "Get the error-rate-over-SLO alert to page 15 times or more in one month." },
  { id: "leak", text: "Make the one-window burn-rate alert catch the slow leak." },
  { id: "all", text: "Make the one-window alert catch every significant incident with no false page. Then look at how long it keeps firing." },
  { id: "quiet", text: "Find the traffic level where even the multiwindow alert pages for nothing." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  incidents: Incident[];
  seq: number;
  tool: Tool;
  traffic: Traffic;
  single: { window: Window; burn: number };
  ran: boolean;
  prediction: string | null;
  done: Partial<Record<ChallengeId, boolean>>;
}

export type Action =
  | { type: "tool"; tool: Tool }
  | { type: "day"; day: number }
  | { type: "traffic"; traffic: Traffic }
  | { type: "window"; window: Window }
  | { type: "burn"; burn: number }
  | { type: "run" }
  | { type: "clear" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    incidents: DEFAULT_INCIDENTS.map((i, k) => ({ ...i, id: k + 1 })), seq: DEFAULT_INCIDENTS.length + 1,
    tool: "outage", traffic: "busy", single: { window: 60, burn: 14.4 }, ran: false, prediction: null, done: {},
  };
}

function progress(s: State): State {
  if (!s.ran) return s;
  const [th, single, multi] = evaluate(s.incidents, s.traffic, s.single);
  const done = { ...s.done };
  if (th.pages >= 15) done.noisy = true;
  const leaks = s.incidents.filter((i) => i.kind === "leak").map((i) => i.id);
  if (single.detections.some((d) => leaks.includes(d.id) && d.at !== null)) done.leak = true;
  if (s.traffic === "busy" && s.incidents.filter(significant).length >= 3 && single.missed === 0 && single.falsePages === 0) done.all = true;
  if (s.traffic === "quiet" && multi.falsePages > 0) done.quiet = true;
  return { ...s, done };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "predict": return s.prediction ? s : { ...s, prediction: a.value };
    case "tool": return { ...s, tool: a.tool };
    case "run": return progress({ ...s, ran: true });
    case "traffic": return progress({ ...s, traffic: a.traffic });
    case "window": return progress({ ...s, single: { ...s.single, window: a.window } });
    case "burn": return progress({ ...s, single: { ...s.single, burn: a.burn } });
    case "clear": return progress({ ...s, incidents: [] });
    case "day": {
      if (a.day < 1 || a.day > DAYS) return s;
      if (s.tool === "remove") {
        const on = s.incidents.filter((i) => i.day === a.day);
        if (!on.length) return s;
        return progress({ ...s, incidents: s.incidents.filter((i) => i.id !== on[on.length - 1].id) });
      }
      if (s.tool === "leak" && a.day > DAYS - 2) return s;
      return progress({ ...s, incidents: [...s.incidents, { id: s.seq, kind: s.tool, day: a.day }], seq: s.seq + 1 });
    }
  }
}
