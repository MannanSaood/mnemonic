// Purpose. After this, the reader can answer: "Why can I plug a brand-new channel (or a test
// fake) into a service that talks to an interface without touching the service, and what does
// the same plug cost a service that checks types?"
//
// The model: one notification service written two ways, receiving the same plugs.
// - interface design: notify() looks up a Notifier and calls send / wakesPeople on it.
//   A plugged type fits only if it has every method of the interface. In statically checked
//   languages a misfit is rejected before it ships; with duck typing (Python) it ships and fails
//   only on the code path that needs the missing method.
// - type-check design: notify() names every channel in two places (the quiet-hours list and the
//   send switch). A new channel fails until both are edited, and forgetting the quiet list wakes
//   customers at night with no error at all.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Design = "iface" | "typed";
export type Typing = "static" | "duck";
export type ChannelId = "email" | "sms" | "push" | "whatsapp" | "slack" | "fake";
export const NAME: Record<ChannelId, string> = { email: "Email", sms: "SMS", push: "Push", whatsapp: "WhatsApp", slack: "Slack", fake: "Fake" };

/** The methods the interface requires. */
export type Method = "send" | "wakesPeople";
export const REQUIRED: Method[] = ["send", "wakesPeople"];

export interface Impl {
  id: ChannelId;
  /** Methods the type actually has (may have extra ones; extras do not matter). */
  methods: (Method | "balance")[];
  /** What wakesPeople() returns, when it exists. */
  wakes: boolean;
  /** A fake records instead of sending. */
  records?: boolean;
}

export const IMPLS: Record<ChannelId, Impl> = {
  email: { id: "email", methods: ["send", "wakesPeople"], wakes: false },
  sms: { id: "sms", methods: ["send", "wakesPeople", "balance"], wakes: true },
  push: { id: "push", methods: ["send", "wakesPeople"], wakes: true },
  whatsapp: { id: "whatsapp", methods: ["send", "wakesPeople"], wakes: true },
  slack: { id: "slack", methods: ["send"], wakes: false },
  fake: { id: "fake", methods: ["send", "wakesPeople"], wakes: false, records: true },
};
export const START: ChannelId[] = ["email", "sms", "push"];
export const TRAY: ChannelId[] = ["whatsapp", "slack", "fake"];

export const missing = (i: Impl): Method[] => REQUIRED.filter((m) => !i.methods.includes(m));
export const fits = (i: Impl) => missing(i).length === 0;

export interface Note {
  id: number;
  channel: ChannelId;
  /** clock time the message is sent */
  at: string;
  night: boolean;
  kind: "sent" | "queued" | "recorded" | "error" | "woke";
  path: string[];
  text: string;
}

export interface Tally { notifyLines: number; newTypeLines: number; testLinesInProd: number; failures: number; wokeUp: number; realSends: number }
const zero = (): Tally => ({ notifyLines: 0, newTypeLines: 0, testLinesInProd: 0, failures: 0, wokeUp: 0, realSends: 0 });

export interface IfaceSide { channels: ChannelId[]; rejected: ChannelId[]; slackFixed: boolean; log: Note[]; total: Tally }
export interface TypedSide { cases: ChannelId[]; quiet: ChannelId[]; log: Note[]; total: Tally }

export interface State {
  typing: Typing;
  plugged: ChannelId[];
  iface: IfaceSide;
  typed: TypedSide;
  seq: number;
  /** The last thing that happened, in one line, for the reader. */
  last: string;
}

export type Action =
  | { type: "setTyping"; typing: Typing }
  | { type: "plug"; id: ChannelId }
  | { type: "fixSlack" }
  | { type: "addCase"; id: ChannelId }
  | { type: "addQuiet"; id: ChannelId }
  | { type: "reset" };

export function init(typing: Typing = "static"): State {
  return {
    typing,
    plugged: [],
    iface: { channels: [...START], rejected: [], slackFixed: false, log: [], total: zero() },
    typed: { cases: [...START], quiet: ["sms", "push"], log: [], total: zero() },
    seq: 0,
    last: "",
  };
}

/** Three customers chose the channel: two in the afternoon, one at 03:12 (quiet hours). */
const TIMES: { at: string; night: boolean }[] = [
  { at: "14:05", night: false },
  { at: "03:12", night: true },
  { at: "16:40", night: false },
];

/** The impl as the interface design sees it (Slack gains its method once fixed). */
function ifaceImpl(s: IfaceSide, id: ChannelId): Impl {
  const i = IMPLS[id];
  return id === "slack" && s.slackFixed ? { ...i, methods: ["send", "wakesPeople"] } : i;
}

function ifaceNote(s: IfaceSide, typing: Typing, id: ChannelId, t: { at: string; night: boolean }, n: number): Note {
  const base = { id: n, channel: id, at: t.at, night: t.night };
  const head = [`${t.at}`, "notify()", "channels[…]"];
  if (!s.channels.includes(id)) return { ...base, kind: "error", path: [...head, "✗"], text: `No ${NAME[id]} in the channel map: unknown channel.` };
  const impl = ifaceImpl(s, id);
  // notify() asks wakesPeople() first, then calls send(). Duck typing fails on the first missing one.
  if (!impl.methods.includes("wakesPeople")) {
    // Only reachable with duck typing: static typing rejected the plug.
    return { ...base, kind: "error", path: [...head, NAME[id], "wakesPeople?", "✗"], text: `${NAME[id]} has no wakesPeople. The call blows up at runtime, on every message, day or night.` };
  }
  if (impl.wakes && t.night) return { ...base, kind: "queued", path: [...head, NAME[id], "wakesPeople → yes", "queue"], text: `${t.at} is quiet hours: queued until 08:00.` };
  if (impl.records) return { ...base, kind: "recorded", path: [...head, NAME[id], "send", "recorded"], text: `The fake recorded the message. Nothing left the building.` };
  return { ...base, kind: "sent", path: [...head, NAME[id], "send", "✓"], text: `Sent by ${NAME[id]}.` };
}

function typedNote(s: TypedSide, id: ChannelId, t: { at: string; night: boolean }, n: number): Note {
  const base = { id: n, channel: id, at: t.at, night: t.night };
  const head = [`${t.at}`, "notify()"];
  const quiet = s.quiet.includes(id);
  if (t.night && quiet) return { ...base, kind: "queued", path: [...head, "quiet list", "queue"], text: `${t.at} is quiet hours: queued until 08:00.` };
  if (!s.cases.includes(id)) return { ...base, kind: "error", path: [...head, "switch", "default", "✗"], text: `The switch has no case for "${id}": unknown channel.` };
  const impl = IMPLS[id];
  if (impl.records) return { ...base, kind: "recorded", path: [...head, "switch", `case "${id}"`, "recorded"], text: "The fake recorded the message, through a case that now lives in production code." };
  if (t.night && impl.wakes) return { ...base, kind: "woke", path: [...head, "switch", `case "${id}"`, "sent"], text: `Sent at ${t.at}. Nobody added "${id}" to the quiet list, so a customer's phone buzzed at night. No error anywhere.` };
  return { ...base, kind: "sent", path: [...head, "switch", `case "${id}"`, "✓"], text: `Sent by ${NAME[id]}.` };
}

function count(total: Tally, notes: Note[]): Tally {
  const t = { ...total };
  for (const x of notes) {
    if (x.kind === "error") t.failures++;
    if (x.kind === "woke") t.wokeUp++;
    if (x.kind === "sent" || x.kind === "woke") t.realSends++;
  }
  return t;
}

/** Traffic for one channel after a change ships on the interface side. */
function runIface(st: State, id: ChannelId): State {
  let seq = st.seq;
  const notes = TIMES.map((t) => ifaceNote(st.iface, st.typing, id, t, ++seq));
  return { ...st, seq, iface: { ...st.iface, log: notes, total: count(st.iface.total, notes) } };
}
function runTyped(st: State, id: ChannelId): State {
  let seq = st.seq;
  const notes = TIMES.map((t) => typedNote(st.typed, id, t, ++seq));
  return { ...st, seq, typed: { ...st.typed, log: notes, total: count(st.typed.total, notes) } };
}

/** Lines a new implementation adds in its own file (never in notify). */
const TYPE_LINES = 6;

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init(st.typing);

    case "setTyping":
      return a.typing === st.typing ? st : init(a.typing);

    case "plug": {
      if (st.plugged.includes(a.id) || START.includes(a.id)) return st;
      let next: State = { ...st, plugged: [...st.plugged, a.id] };
      const impl = IMPLS[a.id];
      // Interface design: the compiler (or nobody, with duck typing) checks the shape.
      if (!fits(impl) && st.typing === "static") {
        next = { ...next, iface: { ...next.iface, rejected: [...next.iface.rejected, a.id], log: [], total: { ...next.iface.total, newTypeLines: next.iface.total.newTypeLines + TYPE_LINES - 1 } } };
        next.last = `${NAME[a.id]} was rejected before it shipped: it is missing ${missing(impl).join(", ")}.`;
      } else {
        next = { ...next, iface: { ...next.iface, channels: [...next.iface.channels, a.id], total: { ...next.iface.total, newTypeLines: next.iface.total.newTypeLines + TYPE_LINES - (fits(impl) ? 0 : 1) } } };
        next = runIface(next, a.id);
        next.last = fits(impl) ? `${NAME[a.id]} fits the interface and shipped. notify() did not change.` : `${NAME[a.id]} shipped without a check, and fails when notify() asks for wakesPeople.`;
      }
      // Type-check design: the plug ships too, but notify() does not know the name yet.
      next = runTyped(next, a.id);
      return next;
    }

    case "fixSlack": {
      const s = st.iface;
      if (!st.plugged.includes("slack") || s.slackFixed) return st;
      const channels = s.channels.includes("slack") ? s.channels : [...s.channels, "slack" as ChannelId];
      let next: State = { ...st, iface: { ...s, slackFixed: true, channels, rejected: s.rejected.filter((x) => x !== "slack"), total: { ...s.total, newTypeLines: s.total.newTypeLines + 1 } } };
      next = runIface(next, "slack");
      next.last = "The fix was one line in Slack's own file. notify() still did not change.";
      return next;
    }

    case "addCase": {
      const s = st.typed;
      if (!st.plugged.includes(a.id) || s.cases.includes(a.id)) return st;
      const test = IMPLS[a.id].records ? 2 : 0;
      let next: State = { ...st, typed: { ...s, cases: [...s.cases, a.id], total: { ...s.total, notifyLines: s.total.notifyLines + 2, testLinesInProd: s.total.testLinesInProd + test } } };
      next = runTyped(next, a.id);
      next.last = `Two lines added to notify() for ${NAME[a.id]}.`;
      return next;
    }

    case "addQuiet": {
      const s = st.typed;
      if (!st.plugged.includes(a.id) || s.quiet.includes(a.id) || !IMPLS[a.id].wakes) return st;
      let next: State = { ...st, typed: { ...s, quiet: [...s.quiet, a.id], total: { ...s.total, notifyLines: s.total.notifyLines + 1 } } };
      next = runTyped(next, a.id);
      next.last = `One line in notify() changed: ${NAME[a.id]} joins the quiet-hours list.`;
      return next;
    }
  }
}

/** The type-check design has caught up with a plugged channel when it can no longer misbehave. */
export function typedReady(s: TypedSide, id: ChannelId): boolean {
  return s.cases.includes(id) && (!IMPLS[id].wakes || s.quiet.includes(id));
}
