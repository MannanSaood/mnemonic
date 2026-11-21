// Reliable links playground: a checkout client, a lossy network and a payment service with a
// ledger. The reader sends a payment, then decides the fate of every message on the wire
// (deliver it, drop it, or deliver it and crash the service before it replies), lets the
// client's timer fire, and watches what lands in the ledger. A batch run replays 100 checkouts
// on a link that drops a share of messages, under each delivery policy side by side.
//
// After this, the reader can answer: "When a request times out, why can't the client tell
// whether the charge happened, and what makes it safe to send the request again?"
// Core insight: a lost request and a lost response look the same to the sender. Not retrying
// loses payments; retrying duplicates them; retrying with an idempotency key that the server
// stores in the same transaction as the charge gives an exactly-once effect.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Policy = "once" | "retry" | "key";
export const POLICIES: Policy[] = ["once", "retry", "key"];
export const POLICY_LABEL: Record<Policy, string> = {
  once: "No retries",
  retry: "Retry on timeout",
  key: "Retry + idempotency key",
};
export const POLICY_NAME: Record<Policy, string> = {
  once: "at most once",
  retry: "at least once",
  key: "exactly-once effect",
};
export const MAX_ATTEMPTS = 4;
export const AMOUNT = 40;

/** Where the current payment is. */
export type Phase = "idle" | "request" | "response" | "waiting" | "done" | "gaveup";

export interface Payment {
  id: number;
  key: string;
  attempts: number;
  /** What the customer was told. */
  outcome: "pending" | "paid" | "error";
}

export interface Charge { id: number; payment: number; attempt: number }

export interface Row {
  n: number;
  dir: "req" | "resp";
  payment: number;
  attempt: number;
  label: string;
  fate: "flying" | "delivered" | "dropped" | "unsent";
  note: string;
}

export interface BatchStats {
  policy: Policy;
  exactlyOnce: number;
  /** Customers charged two or more times. */
  doubled: number;
  extraCharges: number;
  /** Customers never charged. */
  unpaid: number;
  /** Customers who saw an error although their card was charged. */
  chargedButError: number;
  messages: number;
}
export interface Batch { drop: number; runs: number; stats: BatchStats[] }

export interface State {
  policy: Policy;
  /** The service saves the key in the same transaction as the charge. */
  atomic: boolean;
  payments: Payment[];
  current: number | null;
  phase: Phase;
  ledger: Charge[];
  /** Idempotency table on the service: key -> charge id. */
  keys: Record<string, number>;
  rows: Row[];
  messages: number;
  seq: number;
  /** A message the service handled after a crash lost the key (for the "break it" challenge). */
  crashed: boolean;
  dropRate: number;
  batch: Batch | null;
  prediction: string | null;
}

export type Action =
  | { type: "pay" }
  | { type: "deliver" }
  | { type: "drop" }
  | { type: "crash" }
  | { type: "timer" }
  | { type: "setPolicy"; policy: Policy }
  | { type: "setAtomic"; atomic: boolean }
  | { type: "setDrop"; rate: number }
  | { type: "batch" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    policy: "retry",
    atomic: true,
    payments: [],
    current: null,
    phase: "idle",
    ledger: [],
    keys: {},
    rows: [],
    messages: 0,
    seq: 1,
    crashed: false,
    dropRate: 0.2,
    batch: null,
    prediction: null,
  };
}

const keyFor = (id: number) => `pay_${(id * 2654435761 >>> 0).toString(16).slice(0, 6)}`;

/** The current payment, if any. */
export const currentPayment = (s: State) => s.payments.find((p) => p.id === s.current);
/** Charges in the ledger for one payment. */
export const chargesFor = (s: State, id: number) => s.ledger.filter((c) => c.payment === id).length;

function send(s: State, p: Payment): State {
  const attempt = p.attempts + 1;
  const payments = s.payments.map((x) => (x.id === p.id ? { ...x, attempts: attempt } : x));
  const withKey = s.policy === "key" ? ` · key ${p.key}` : "";
  const row: Row = { n: s.seq, dir: "req", payment: p.id, attempt, label: `POST /charges $${AMOUNT}${withKey}`, fate: "flying", note: "" };
  return { ...s, payments, seq: s.seq + 1, messages: s.messages + 1, phase: "request", rows: [...s.rows, row] };
}

function setLast(s: State, patch: Partial<Row>): Row[] {
  const rows = [...s.rows];
  rows[rows.length - 1] = { ...rows[rows.length - 1], ...patch };
  return rows;
}

/** The service handles a request that arrived. Returns the new state and what it answered. */
function serve(s: State, p: Payment, attempt: number, crash: boolean): { s: State; note: string; chargeId: number } {
  if (s.policy === "key" && s.keys[p.key] !== undefined) {
    const id = s.keys[p.key];
    return { s, note: `key seen: replays charge #${id}, charges nothing`, chargeId: id };
  }
  const charge: Charge = { id: s.ledger.length + 1, payment: p.id, attempt };
  const ledger = [...s.ledger, charge];
  const repeat = chargesFor(s, p.id) > 0;
  let keys = s.keys;
  let note = repeat ? `charged AGAIN: charge #${charge.id}` : `charged: charge #${charge.id}`;
  if (s.policy === "key") {
    if (crash && !s.atomic) note += ", crashed before saving the key";
    else keys = { ...keys, [p.key]: charge.id };
  }
  return { s: { ...s, ledger, keys, crashed: s.crashed || (crash && !s.atomic && s.policy === "key") }, note, chargeId: charge.id };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();

    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };

    case "setPolicy":
      if (s.phase === "request" || s.phase === "response" || s.phase === "waiting") return s;
      return { ...s, policy: a.policy };

    case "setAtomic":
      return { ...s, atomic: a.atomic };

    case "setDrop":
      return { ...s, dropRate: Math.max(0, Math.min(0.6, a.rate)) };

    case "batch":
      return { ...s, batch: runBatch(s.dropRate, 100) };

    case "pay": {
      if (s.phase === "request" || s.phase === "response" || s.phase === "waiting") return s;
      const p: Payment = { id: s.payments.length + 1, key: keyFor(s.payments.length + 1), attempts: 0, outcome: "pending" };
      return send({ ...s, payments: [...s.payments, p], current: p.id }, p);
    }

    case "deliver":
    case "crash": {
      const p = currentPayment(s);
      if (!p) return s;
      if (s.phase === "request") {
        const crash = a.type === "crash";
        const r = serve(s, p, p.attempts, crash);
        let next: State = { ...r.s, rows: setLast(s, { fate: "delivered", note: r.note }) };
        if (crash) {
          const row: Row = { n: next.seq, dir: "resp", payment: p.id, attempt: p.attempts, label: "200 OK", fate: "unsent", note: "never sent: the service crashed" };
          return { ...next, seq: next.seq + 1, rows: [...next.rows, row], phase: "waiting" };
        }
        const row: Row = { n: next.seq, dir: "resp", payment: p.id, attempt: p.attempts, label: `200 OK · charge #${r.chargeId}`, fate: "flying", note: "" };
        next = { ...next, seq: next.seq + 1, messages: next.messages + 1, rows: [...next.rows, row], phase: "response" };
        return next;
      }
      if (s.phase === "response" && a.type === "deliver") {
        const payments = s.payments.map((x) => (x.id === p.id ? { ...x, outcome: "paid" as const } : x));
        return { ...s, payments, rows: setLast(s, { fate: "delivered", note: "customer sees: paid" }), phase: "done" };
      }
      return s;
    }

    case "drop": {
      if (s.phase !== "request" && s.phase !== "response") return s;
      return { ...s, rows: setLast(s, { fate: "dropped", note: s.phase === "request" ? "lost before the service saw it" : "lost on the way back" }), phase: "waiting" };
    }

    case "timer": {
      const p = currentPayment(s);
      if (!p || s.phase !== "waiting") return s;
      if (s.policy === "once" || p.attempts >= MAX_ATTEMPTS) {
        const payments = s.payments.map((x) => (x.id === p.id ? { ...x, outcome: "error" as const } : x));
        return { ...s, payments, phase: "gaveup" };
      }
      return send(s, p);
    }
  }
}

/* ---------------- results ---------------- */

export interface Tally { payments: number; charges: number; doubled: number; unpaid: number; chargedButError: number; paidOnce: number }

/** What the reader's own payments did, finished ones only. */
export function tally(s: State): Tally {
  const finished = s.payments.filter((p) => p.outcome !== "pending");
  let doubled = 0, unpaid = 0, chargedButError = 0, paidOnce = 0;
  for (const p of finished) {
    const c = chargesFor(s, p.id);
    if (c > 1) doubled++;
    if (c === 0) unpaid++;
    if (c > 0 && p.outcome === "error") chargedButError++;
    if (c === 1 && p.outcome === "paid") paidOnce++;
  }
  return { payments: finished.length, charges: s.ledger.filter((c) => finished.some((p) => p.id === c.payment)).length, doubled, unpaid, chargedButError, paidOnce };
}

/* ---------------- batch run ---------------- */

/** Small deterministic generator so a batch is the same every time for the same drop rate. */
function rand(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const BATCH_ATTEMPTS = 6;

/** Simulate `runs` checkouts per policy. Each policy sees the same sequence of network luck. */
export function runBatch(drop: number, runs: number): Batch {
  const stats = POLICIES.map((policy): BatchStats => {
    const r = rand(Math.round(drop * 1000) * 7919 + 17);
    const st: BatchStats = { policy, exactlyOnce: 0, doubled: 0, extraCharges: 0, unpaid: 0, chargedButError: 0, messages: 0 };
    for (let i = 0; i < runs; i++) {
      let charges = 0, keySaved = false, paid = false;
      const max = policy === "once" ? 1 : BATCH_ATTEMPTS;
      for (let attempt = 1; attempt <= max && !paid; attempt++) {
        st.messages++;
        const reqLost = r() < drop;
        const respLost = r() < drop;
        if (reqLost) continue;
        if (policy !== "key" || !keySaved) {
          charges++;
          if (policy === "key") keySaved = true;
        }
        st.messages++;
        if (!respLost) paid = true;
      }
      if (charges === 1 && paid) st.exactlyOnce++;
      if (charges > 1) { st.doubled++; st.extraCharges += charges - 1; }
      if (charges === 0) st.unpaid++;
      if (charges > 0 && !paid) st.chargedButError++;
    }
    return st;
  });
  return { drop, runs, stats };
}

/* ---------------- guided challenges ---------------- */

export const CHALLENGES = [
  { id: "doubled", text: "With Retry on timeout, get one customer charged twice." },
  { id: "silent", text: "With No retries, take the money and still show the customer an error." },
  { id: "keyed", text: "With the idempotency key, lose two messages for one payment and still charge it once." },
  { id: "broken", text: "Untick the transaction, crash the service mid-charge, and get a double charge even with the key." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeDone(s: State, id: ChallengeId): boolean {
  switch (id) {
    case "doubled":
      return s.payments.some((p) => chargesFor(s, p.id) > 1 && !s.rows.some((r) => r.payment === p.id && r.label.includes("key")));
    case "silent":
      return s.payments.some((p) => p.outcome === "error" && p.attempts === 1 && chargesFor(s, p.id) === 1);
    case "keyed":
      return s.payments.some((p) => p.outcome === "paid" && chargesFor(s, p.id) === 1 && p.attempts >= 3 && s.rows.some((r) => r.payment === p.id && r.label.includes("key")));
    case "broken":
      return s.crashed && s.payments.some((p) => chargesFor(s, p.id) > 1 && s.rows.some((r) => r.payment === p.id && r.label.includes("key")));
  }
}
