// Command playground: an admin console for one customer account. Every button creates a command
// object (a name plus its arguments), which waits in a queue until a worker runs it against the
// billing provider. The reader controls the network on the next attempt, runs the worker, retries
// and undoes.
//
// After this, the reader can answer: "Once an action is an object I can queue, retry and undo,
// what must the object carry so that a retry does not refund the customer twice and an undo puts
// things back?"
// Core insight: making a request into an object is what makes queueing, retrying, logging and
// undo possible, but each one only works if the command carries what it needs: an idempotency
// key for safe retries, and the before-state for undo. Some commands cannot be undone at all.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Kind = "refund" | "plan" | "credit" | "email";
export type Fault = "ok" | "refused" | "lost";

export const KINDS: Kind[] = ["refund", "plan", "credit", "email"];
export const BUTTON: Record<Kind, string> = {
  refund: "Refund $40 for order 1042",
  plan: "Move to the Pro plan",
  credit: "Add $25 goodwill credit",
  email: "Email the invoice",
};
/** Can this kind of command be reversed by the system on its own? */
export const UNDOABLE: Record<Kind, boolean> = { refund: false, plan: true, credit: true, email: false };
/** Running it twice has the same effect as once, even without a key. */
export const NATURALLY_IDEMPOTENT: Record<Kind, boolean> = { refund: false, plan: true, credit: false, email: false };
export const MAX_ATTEMPTS = 3;

export interface Command {
  id: number;
  kind: Kind;
  args: Record<string, string | number>;
  /** Sent with every attempt when idempotency keys are on. */
  key: string;
  attempts: number;
  status: "queued" | "retrying" | "done" | "dead" | "undone";
  /** Captured on the first successful application, for undo. */
  before?: string | number;
  /** An earlier attempt reached the provider but its response was lost. */
  lost?: boolean;
  /** Already counted in what the admin intended. */
  counted?: boolean;
}

export interface Account { plan: string; credit: number; refunded: number; emails: number }

export interface LogLine { n: number; id: number; text: string; tone: "ok" | "bad" | "warn" | "undo" }

export interface State {
  account: Account;
  /** What the reader asked for, to compare against what actually happened. */
  intended: Account;
  queue: Command[];
  history: Command[];
  /** Idempotency keys the provider has already applied. */
  seenKeys: string[];
  useKeys: boolean;
  /** Network behaviour on the next attempt only. */
  fault: Fault;
  log: LogLine[];
  seq: number;
  logSeq: number;
  /** Set on the first retry of a refund whose response was lost: what the customer ended up with. */
  retryAfterLost: { kind: Kind; keyed: boolean; duplicated: boolean } | null;
  prediction: string | null;
  retries: number;
  undos: number;
  refusedUndo: Kind | null;
}

export type Action =
  | { type: "issue"; kind: Kind }
  | { type: "setFault"; fault: Fault }
  | { type: "setKeys"; on: boolean }
  | { type: "work" }
  | { type: "undo" }
  | { type: "predict"; value: string }
  | { type: "reset" };

const START: Account = { plan: "Basic", credit: 0, refunded: 0, emails: 0 };

export function init(): State {
  return {
    account: { ...START },
    intended: { ...START },
    queue: [],
    history: [],
    seenKeys: [],
    useKeys: false,
    fault: "ok",
    log: [],
    seq: 1,
    logSeq: 1,
    retryAfterLost: null,
    prediction: null,
    retries: 0,
    undos: 0,
    refusedUndo: null,
  };
}

function argsFor(kind: Kind): Command["args"] {
  switch (kind) {
    case "refund": return { order: 1042, amount: 40 };
    case "plan": return { to: "Pro" };
    case "credit": return { amount: 25 };
    case "email": return { template: "invoice" };
  }
}

/** The command as it would be stored in a queue or audit log. */
export function serialize(c: Command, withKey: boolean): string {
  const fields = Object.entries(c.args).map(([k, v]) => `"${k}":${typeof v === "number" ? v : `"${v}"`}`);
  return `{"cmd":"${c.kind}",${fields.join(",")}${withKey ? `,"key":"${c.key}"` : ""}}`;
}

function applyIntent(a: Account, c: Command): Account {
  switch (c.kind) {
    case "refund": return { ...a, refunded: a.refunded + Number(c.args.amount) };
    case "plan": return { ...a, plan: String(c.args.to) };
    case "credit": return { ...a, credit: a.credit + Number(c.args.amount) };
    case "email": return { ...a, emails: a.emails + 1 };
  }
}

/** The provider applies the command, unless it has seen this key before. */
function provider(s: State, c: Command): { account: Account; seenKeys: string[]; applied: boolean } {
  if (s.useKeys && s.seenKeys.includes(c.key)) return { account: s.account, seenKeys: s.seenKeys, applied: false };
  return { account: applyIntent(s.account, c), seenKeys: s.useKeys ? [...s.seenKeys, c.key] : s.seenKeys, applied: true };
}

const money = (n: number) => `$${n}`;
function describe(c: Command): string {
  switch (c.kind) {
    case "refund": return `refund ${money(Number(c.args.amount))} on order ${c.args.order}`;
    case "plan": return `plan → ${c.args.to}`;
    case "credit": return `credit +${money(Number(c.args.amount))}`;
    case "email": return "email invoice";
  }
}

function log(s: State, id: number, text: string, tone: LogLine["tone"]): Pick<State, "log" | "logSeq"> {
  return { log: [{ n: s.logSeq, id, text, tone }, ...s.log].slice(0, 30), logSeq: s.logSeq + 1 };
}

/** The last executed command that is still in effect: the one Undo would act on. */
export const undoTarget = (s: State): Command | undefined => [...s.history].reverse().find((c) => c.status === "done");

/** What went wrong compared with what the admin asked for. */
export function drift(s: State) {
  return {
    extraRefund: s.account.refunded - s.intended.refunded,
    extraCredit: s.account.credit - s.intended.credit,
    extraEmails: s.account.emails - s.intended.emails,
  };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };

    case "setFault":
      return { ...s, fault: a.fault };

    case "setKeys":
      return { ...s, useKeys: a.on };

    case "issue": {
      const c: Command = { id: s.seq, kind: a.kind, args: argsFor(a.kind), key: `${a.kind}-${s.seq}`, attempts: 0, status: "queued" };
      return { ...s, seq: s.seq + 1, queue: [...s.queue, c], ...log(s, c.id, `queued #${c.id}: ${describe(c)}`, "ok") };
    }

    case "work": {
      const head = s.queue[0];
      if (!head) return s;
      const fault = s.fault;
      const isRetry = head.attempts > 0;
      const c: Command = { ...head, attempts: head.attempts + 1 };
      let next: State = { ...s, fault: "ok", retries: s.retries + (isRetry ? 1 : 0) };
      const requeue = (cmd: Command, text: string, tone: LogLine["tone"]): State => {
        const dead = cmd.attempts >= MAX_ATTEMPTS;
        const q = { ...cmd, status: (dead ? "dead" : "retrying") as Command["status"] };
        return {
          ...next,
          queue: dead ? s.queue.slice(1) : [q, ...s.queue.slice(1)],
          history: dead ? [...s.history, q] : s.history,
          ...log(next, cmd.id, `${text} ${dead ? "Gave up." : "Will retry."}`, tone),
        };
      };

      if (fault === "refused") {
        // The request never reached the provider: nothing happened, so a retry is safe.
        return requeue(c, `#${c.id} attempt ${c.attempts}: connection refused. Nothing was applied.`, "warn");
      }

      // The provider receives it (on "ok" and on "lost").
      const p = provider(s, c);
      if (p.applied && c.before === undefined) {
        if (c.kind === "plan") c.before = s.account.plan;
        if (c.kind === "credit") c.before = s.account.credit;
      }
      next = { ...next, account: p.account, seenKeys: p.seenKeys };
      // The admin asked for this once: count it once, the first time it reaches the provider.
      if (!c.counted) {
        c.counted = true;
        next = { ...next, intended: applyIntent(s.intended, c) };
      }
      const redelivery = isRetry && !!head.lost;
      const duplicated = redelivery && p.applied && !NATURALLY_IDEMPOTENT[c.kind];
      if (redelivery && c.kind === "refund" && !s.retryAfterLost) next = { ...next, retryAfterLost: { kind: c.kind, keyed: !p.applied, duplicated } };

      if (fault === "lost") {
        // Applied (or ignored by key), but the response was lost: the worker cannot tell, so it retries.
        return requeue({ ...c, lost: true },
          `#${c.id} attempt ${c.attempts}: timed out. ${p.applied ? "The provider DID apply it" : "The provider recognised the key and ignored it"}, but the worker cannot know that.`,
          "bad");
      }

      const text = !p.applied
        ? `#${c.id} attempt ${c.attempts}: the provider has seen key ${c.key} and returned the first result. Applied once.`
        : duplicated
          ? `#${c.id} attempt ${c.attempts}: applied AGAIN. ${describe(c)} has now happened twice.`
          : redelivery
            ? `#${c.id} attempt ${c.attempts}: applied again, harmlessly: ${describe(c)} sets a value, so twice is the same as once.`
            : `#${c.id} attempt ${c.attempts}: done, ${describe(c)}.`;
      return {
        ...next,
        queue: s.queue.slice(1),
        history: [...s.history, { ...c, status: "done" }],
        ...log(next, c.id, text, duplicated ? "bad" : "ok"),
      };
    }

    case "undo": {
      const t = undoTarget(s);
      if (!t) return s;
      if (!UNDOABLE[t.kind]) {
        const why = t.kind === "refund"
          ? `#${t.id} cannot be undone: the money has left. Charging the card again needs the customer's consent.`
          : `#${t.id} cannot be undone: the email is in the customer's inbox.`;
        return { ...s, refusedUndo: t.kind, ...log(s, t.id, why, "warn") };
      }
      const history = s.history.map((c) => (c.id === t.id ? { ...c, status: "undone" as const } : c));
      let account = s.account, intended = s.intended, text = "";
      if (t.kind === "plan") {
        account = { ...account, plan: String(t.before) };
        intended = { ...intended, plan: String(t.before) };
        text = `undo #${t.id}: plan back to ${t.before}, the value the command saved before it ran.`;
      } else {
        const amt = Number(t.args.amount);
        account = { ...account, credit: account.credit - amt };
        intended = { ...intended, credit: intended.credit - amt };
        text = `undo #${t.id}: credit -${money(amt)}.`;
      }
      return { ...s, account, intended, history, undos: s.undos + 1, ...log(s, t.id, text, "undo") };
    }
  }
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "double", text: "Queue the refund, set the next attempt to time out after success, then run the worker twice." },
  { id: "keyed", text: "Turn on idempotency keys and do it again. How much leaves this time?" },
  { id: "undo", text: "Move the account to Pro, run it, then undo it." },
  { id: "refuse", text: "Run a refund, then try to undo it." },
] as const;

export function challengeDone(s: State, id: (typeof CHALLENGES)[number]["id"]): boolean {
  switch (id) {
    case "double": return drift(s).extraRefund > 0;
    case "keyed": return s.history.some((c) => c.lost && c.kind === "refund" && c.status === "done" && s.seenKeys.includes(c.key));
    case "undo": return s.history.some((c) => c.kind === "plan" && c.status === "undone");
    case "refuse": return s.refusedUndo === "refund";
  }
}
