// Bridge playground: alerts have two dimensions that change for different reasons. What an
// alert says (incident, digest, reminder, ...) and where it goes (Slack, email, PagerDuty, ...).
// The reader grows both, ships change requests that touch one dimension, and watches the same
// grid of real rendered messages cost N × M classes with one class per pair, or N + M with a
// bridge between an Alert hierarchy and a Channel hierarchy.
//
// Purpose. After this, the reader can answer: "Why split two independent dimensions into two
// hierarchies joined by a reference, and what does the joint (the Channel interface) cost?"
// Adding a kind or a channel is one class, a change to one kind or one channel is one edit, but
// a new primitive on the Channel interface touches every channel.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const KINDS = ["incident", "digest", "reminder", "sla", "deploy"] as const;
export type Kind = (typeof KINDS)[number];
export const CHANNELS = ["slack", "email", "pagerduty", "sms", "teams"] as const;
export type Channel = (typeof CHANNELS)[number];

export const KIND_NAME: Record<Kind, string> = { incident: "Incident", digest: "Digest", reminder: "Reminder", sla: "SLA breach", deploy: "Deploy notice" };
export const CHANNEL_NAME: Record<Channel, string> = { slack: "Slack", email: "Email", pagerduty: "PagerDuty", sms: "SMS", teams: "Teams" };

/** Characters in one SMS segment (GSM-7). Longer texts are cut by our SMS provider settings. */
export const SMS_LIMIT = 160;

export type Change = "runbook" | "blocks" | "maxlen";
export const CHANGES: Record<Change, { title: string; why: string; dimension: "kind" | "channel" | "joint" }> = {
  runbook: { title: "Incidents must link their runbook", why: "On-call asked for the runbook link in every incident, on every channel.", dimension: "kind" },
  blocks: { title: "Slack: move from legacy attachments to Block Kit", why: "Slack recommends Block Kit for new messages; every Slack message changes format.", dimension: "channel" },
  maxlen: { title: "Give Channel a MaxLength() primitive", why: "So an alert can fit itself to a channel that has a hard size limit, such as SMS.", dimension: "joint" },
};

export interface Cost { inheritance: number; bridge: number }

export interface State {
  kinds: Kind[];
  channels: Channel[];
  guess: string | null;
  shipped: Change[];
  /** Edits each design needed, per change request shipped, and in total. */
  edits: Cost;
  perChange: Partial<Record<Change, Cost>>;
  /** Class counts after each step, for the growth chart. */
  history: { label: string; inheritance: number; bridge: number }[];
}

export type Action =
  | { type: "guess"; guess: string }
  | { type: "addKind"; kind: Kind }
  | { type: "addChannel"; channel: Channel }
  | { type: "ship"; change: Change }
  | { type: "reset" };

export const classes = (k: number, c: number): Cost => ({ inheritance: k * c, bridge: k + c });

export function init(): State {
  const kinds: Kind[] = ["incident", "digest", "reminder"];
  const channels: Channel[] = ["slack", "email", "pagerduty"];
  return { kinds, channels, guess: null, shipped: [], edits: { inheritance: 0, bridge: 0 }, perChange: {}, history: [{ label: "today", ...classes(3, 3) }] };
}

/** The prediction is revealed once SMS and SLA breach are both in. */
export const revealed = (s: State) => s.kinds.includes("sla") && s.channels.includes("sms");

/* ---------------- what each alert says, and how each channel delivers it ---------------- */

const DIGEST_ITEMS = ["disk 91% on db-2", "p99 1.8 s on api", "cert expires in 9 days on edge-3", "queue lag 4 min on billing", "5xx 0.4% on search", "replica lag 30 s on db-4", "OOM kill on worker-7", "backup took 2 h 10 min"];

export interface Msg { title: string; body: string; severity: "critical" | "warning" | "info"; short: string }

/** The abstraction side: what each kind of alert says. `short` is used when a channel is small. */
export function compose(kind: Kind, s: State): Msg {
  switch (kind) {
    case "incident": {
      const rb = s.shipped.includes("runbook") ? " Runbook: wiki/checkout-5xx" : "";
      return { title: "SEV2 checkout errors", body: `Error rate 7% (threshold 2%) since 14:02.${rb}`, severity: "critical", short: `SEV2 checkout errors 7%.${rb}` };
    }
    case "digest":
      return { title: "Daily digest: 12 alerts, 3 critical", body: DIGEST_ITEMS.join("; ") + "; and 4 more.", severity: "info", short: "Daily digest: 12 alerts, 3 critical. Top: disk 91% on db-2. Full list: ops.example/digest" };
    case "reminder":
      return { title: "On-call handover in 30 min", body: "You take over from Ben at 18:00. 2 open incidents.", severity: "info", short: "On-call handover at 18:00. 2 open incidents." };
    case "sla":
      return { title: "SLA at risk: search", body: "99.71% this month against a 99.9% target. 21 min of budget left.", severity: "warning", short: "SLA at risk: search 99.71% vs 99.9%." };
    case "deploy":
      return { title: "Deployed api v412", body: "Finished in 6 min. Error rate unchanged.", severity: "info", short: "Deployed api v412. OK." };
  }
}

export interface Rendered { lines: string[]; broken: string | null }

/** The implementor side: how each channel delivers a message, from a few primitives. */
export function render(kind: Kind, ch: Channel, s: State): Rendered {
  const m = compose(kind, s);
  const blocks = s.shipped.includes("blocks");
  switch (ch) {
    case "slack":
      return { lines: [blocks ? `[header] ${m.title}` : `attachment: *${m.title}*`, blocks ? `[section] ${m.body}` : m.body], broken: null };
    case "teams":
      return { lines: [`[card] ${m.title}`, m.body], broken: null };
    case "email":
      return { lines: [`Subject: [${m.severity}] ${m.title}`, m.body], broken: null };
    case "pagerduty": {
      const page = m.severity === "critical";
      return { lines: [`${page ? "PAGE on-call" : "event, no page"} · severity=${m.severity}`, m.short], broken: null };
    }
    case "sms": {
      const fit = s.shipped.includes("maxlen");
      const full = fit ? m.short : `${m.title}. ${m.body}`;
      if (full.length <= SMS_LIMIT) return { lines: [full], broken: null };
      return { lines: [full.slice(0, SMS_LIMIT - 1) + "…"], broken: `cut at ${SMS_LIMIT} characters; ${full.length - SMS_LIMIT + 1} lost` };
    }
  }
}

export function broken(s: State): { kind: Kind; channel: Channel; why: string }[] {
  const out: { kind: Kind; channel: Channel; why: string }[] = [];
  for (const k of s.kinds) for (const c of s.channels) {
    const r = render(k, c, s);
    if (r.broken) out.push({ kind: k, channel: c, why: r.broken });
  }
  return out;
}

/** Edits a change needs in each design, given the current grid. */
export function changeCost(change: Change, s: State): Cost {
  const k = s.kinds.length, c = s.channels.length;
  if (change === "runbook") return { inheritance: c, bridge: 1 };          // every Incident×channel class, or Incident once
  if (change === "blocks") return { inheritance: k, bridge: 1 };           // every kind×Slack class, or Slack once
  // a new primitive on the joint: every channel implements it, and the one alert that uses it changes.
  // One class per pair only needed to fix the pairs that overflow.
  const overflow = broken({ ...s, shipped: s.shipped.filter((x) => x !== "maxlen") }).length;
  return { inheritance: overflow, bridge: c + 1 };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return revealed(st) ? st : { ...st, guess: a.guess };
    case "addKind": {
      if (st.kinds.includes(a.kind)) return st;
      const kinds = [...st.kinds, a.kind];
      return { ...st, kinds, history: [...st.history, { label: `+ ${KIND_NAME[a.kind]}`, ...classes(kinds.length, st.channels.length) }] };
    }
    case "addChannel": {
      if (st.channels.includes(a.channel)) return st;
      const channels = [...st.channels, a.channel];
      return { ...st, channels, history: [...st.history, { label: `+ ${CHANNEL_NAME[a.channel]}`, ...classes(st.kinds.length, channels.length) }] };
    }
    case "ship": {
      if (st.shipped.includes(a.change)) return st;
      if (a.change === "maxlen" && !st.channels.includes("sms")) return st;
      const cost = changeCost(a.change, st);
      return {
        ...st,
        shipped: [...st.shipped, a.change],
        perChange: { ...st.perChange, [a.change]: cost },
        edits: { inheritance: st.edits.inheritance + cost.inheritance, bridge: st.edits.bridge + cost.bridge },
      };
    }
  }
}
