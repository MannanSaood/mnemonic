// Adapter playground: our code speaks PaymentGateway; the legacy Acme acquirer speaks its own
// SDK. The reader builds the AcmeAdapter decision by decision and runs a contract suite of five
// real-looking payments through it, watching each call get translated in and the reply
// translated back.
//
// Purpose. After this, the reader can answer: "What work does an adapter actually do, and why
// does it pay to keep all of it in one place?" An adapter is not a rename. It converts units,
// maps result codes, maps errors and sometimes supplies behaviour the vendor lacks
// (idempotency). Each one, done naively, charges a real customer the wrong amount or twice,
// and none of the callers ever change while the reader fixes it.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Decision = "amount" | "status" | "errors" | "retry";
export const DECISIONS: Decision[] = ["amount", "status", "errors", "retry"];

export interface Adapter {
  /** fixed2: cents / 100 with two decimals. exponent: by the currency's ISO 4217 minor unit. */
  amount: "fixed2" | "exponent";
  /** okOrError: "00" is success, anything else an error. mapped: "05"/"51" are declines. */
  status: "okOrError" | "mapped";
  /** raw: Acme's own exceptions escape. wrapped: mapped to our GatewayError, marked retryable. */
  errors: "raw" | "wrapped";
  /** none: Acme has no idempotency keys, so a retry charges again. lookup: send our key as merchant_ref, look it up first. */
  retry: "none" | "lookup";
}
export const NAIVE: Adapter = { amount: "fixed2", status: "okOrError", errors: "raw", retry: "none" };
export const GOOD: Adapter = { amount: "exponent", status: "mapped", errors: "wrapped", retry: "lookup" };

/** What kind of work each decision is, on the spectrum from renaming to adding behaviour. */
export const WORK: Record<Decision, string> = { amount: "Convert units", status: "Map results", errors: "Map errors", retry: "Add what Acme lacks" };

/** ISO 4217 minor units for the currencies in the suite. */
export const EXPONENT: Record<string, number> = { EUR: 2, JPY: 0, KWD: 3 };

export interface Call {
  id: string;
  caller: "checkout" | "renewals";
  amount: number; // in minor units, as our code stores it
  currency: "EUR" | "JPY" | "KWD";
  /** How Acme will respond. */
  acme: "ok" | "decline" | "timeoutAfterCharge";
  label: string;
}

export const CALLS: Call[] = [
  { id: "A-1001", caller: "checkout", amount: 1250, currency: "EUR", acme: "ok", label: "€12.50 order" },
  { id: "J-2002", caller: "checkout", amount: 1250, currency: "JPY", acme: "ok", label: "¥1,250 order" },
  { id: "K-3003", caller: "renewals", amount: 12500, currency: "KWD", acme: "ok", label: "KWD 12.500 subscription renewal" },
  { id: "A-1004", caller: "checkout", amount: 4200, currency: "EUR", acme: "decline", label: "€42.00 order, card declined" },
  { id: "A-1005", caller: "checkout", amount: 9900, currency: "EUR", acme: "timeoutAfterCharge", label: "€99.00 order, Acme times out after charging" },
];

/** Formats an amount in a currency's major units, for display. */
export function money(minor: number, currency: string): string {
  const e = EXPONENT[currency];
  const v = (minor / 10 ** e).toFixed(e);
  const sym = currency === "EUR" ? "€" : currency === "JPY" ? "¥" : "KWD ";
  return sym + (currency === "JPY" ? Number(v).toLocaleString("en-US") : v);
}

/** The string the adapter puts in Acme's `amount` field. */
export function acmeAmount(a: Adapter, c: Call): string {
  return a.amount === "fixed2" ? (c.amount / 100).toFixed(2) : (c.amount / 10 ** EXPONENT[c.currency]).toFixed(EXPONENT[c.currency]);
}

/** What Acme actually charges, in minor units: it reads major units and drops digits the currency does not have. */
export function acmeCharges(amountField: string, currency: string): number {
  const e = EXPONENT[currency];
  return Math.floor(Number(amountField) * 10 ** e + 1e-9);
}

export interface Hop { text: string; bad?: boolean }

export interface Outcome {
  call: Call;
  /** Our call, Acme request, Acme reply, what the adapter returned, what the customer saw. Repeated for a retry. */
  hops: Hop[];
  charged: number; // total minor units actually taken from the customer
  chargeCount: number;
  customerSaw: string;
  checks: { id: string; text: string; ok: boolean }[];
}

export interface Metrics { checksPassed: number; checksTotal: number; wrongAmounts: number; doubleCharges: number; errors500: number; misleading: number }
export interface Run { adapter: Adapter; outcomes: Outcome[]; metrics: Metrics }

function attempt(a: Adapter, c: Call, charged: Set<string>, hops: Hop[]): { result: "succeeded" | "declined" | "gatewayError" | "retryable" | "raw"; amount: number; charge: boolean } {
  // Idempotency the vendor lacks: look the merchant_ref up before charging again.
  if (a.retry === "lookup" && charged.has(c.id)) {
    hops.push({ text: `acme.find_by_ref("${c.id}") → found` });
    hops.push({ text: "return the first receipt" });
    return { result: "succeeded", amount: 0, charge: false };
  }
  const field = acmeAmount(a, c);
  hops.push({ text: `acme.make_payment(amount="${field}", curr="${c.currency}")` });
  if (c.acme === "decline") {
    hops.push({ text: 'result_code "05"' });
    if (a.status === "mapped") { hops.push({ text: "Status.DECLINED" }); return { result: "declined", amount: 0, charge: false }; }
    hops.push({ text: "GatewayError (not retryable)", bad: true });
    return { result: "gatewayError", amount: 0, charge: false };
  }
  const amount = acmeCharges(field, c.currency);
  charged.add(c.id);
  if (c.acme === "timeoutAfterCharge") {
    hops.push({ text: `charged ${money(amount, c.currency)}, then AcmeTimeout` });
    if (a.errors === "wrapped") { hops.push({ text: "GatewayError (retryable)" }); return { result: "retryable", amount, charge: true }; }
    hops.push({ text: "AcmeTimeout escapes", bad: true });
    return { result: "raw", amount, charge: true };
  }
  hops.push({ text: `result_code "00", charged ${money(amount, c.currency)}`, bad: amount !== c.amount });
  hops.push({ text: "Status.SUCCEEDED" });
  return { result: "succeeded", amount, charge: true };
}

/** Runs the contract suite through an adapter. Pure. */
export function simulate(a: Adapter): Run {
  const outcomes = CALLS.map((c): Outcome => {
    const charged = new Set<string>();
    const hops: Hop[] = [{ text: `${c.caller}: gateway.charge(${c.amount}, "${c.currency}", "${c.id}")` }];
    let total = 0, count = 0;
    let r = attempt(a, c, charged, hops);
    if (r.charge) { total += r.amount; count++; }
    let saw: string;
    if (r.result === "retryable" || r.result === "raw") {
      // Our callers already retry a retryable GatewayError once with the same key.
      // An unknown exception becomes an HTTP 500, and the customer presses Pay again: same order, same key.
      saw = r.result === "retryable" ? "" : "HTTP 500. Presses Pay again.";
      hops.push({ text: r.result === "retryable" ? "checkout retries with the same key" : "HTTP 500 → customer presses Pay again", bad: r.result === "raw" });
      const again: Call = { ...c, acme: "ok" };
      const r2 = attempt(a, again, charged, hops);
      if (r2.charge) {
        total += r2.amount; count++;
        hops[hops.length - 2] = { text: hops[hops.length - 2].text + " again", bad: true };
      }
      saw = (saw ? saw + " " : "") + "Payment succeeded.";
    } else if (r.result === "declined") saw = "Card declined. Try another card.";
    else if (r.result === "gatewayError") saw = "Payments are unavailable. Try again later.";
    else saw = "Payment succeeded.";
    const checks: Outcome["checks"] = [];
    if (c.acme === "ok") checks.push({ id: `${c.id}-amount`, text: `${c.label}: charged exactly ${money(c.amount, c.currency)}`, ok: total === c.amount && count === 1 });
    if (c.acme === "decline") checks.push({ id: `${c.id}-decline`, text: "A declined card is reported as a decline", ok: saw.startsWith("Card declined") });
    if (c.acme === "timeoutAfterCharge") {
      checks.push({ id: `${c.id}-no500`, text: "A timeout never shows the customer an HTTP 500", ok: !saw.includes("500") });
      checks.push({ id: `${c.id}-once`, text: "A timeout and a retry still charge only once", ok: count === 1 });
    }
    return { call: c, hops, charged: total, chargeCount: count, customerSaw: saw, checks };
  });
  const all = outcomes.flatMap((o) => o.checks);
  return {
    adapter: { ...a },
    outcomes,
    metrics: {
      checksPassed: all.filter((x) => x.ok).length,
      checksTotal: all.length,
      wrongAmounts: outcomes.filter((o) => o.call.acme === "ok" && o.charged !== o.call.amount).length,
      doubleCharges: outcomes.filter((o) => o.chargeCount > 1).length,
      errors500: outcomes.filter((o) => o.customerSaw.includes("500")).length,
      misleading: outcomes.filter((o) => o.call.acme === "decline" && !o.customerSaw.startsWith("Card declined")).length,
    },
  };
}

/** Which decision each check depends on. */
export const CHECK_DECISION: Record<string, Decision> = {
  "J-2002-amount": "amount", "K-3003-amount": "amount", "A-1001-amount": "amount",
  "A-1004-decline": "status", "A-1005-no500": "errors", "A-1005-once": "retry",
};

/* ---------------- state and step ---------------- */

export type Guess = "right" | "under" | "rejected";

export interface State {
  adapter: Adapter;
  guess: Guess | null;
  run: Run | null;
  first: Run | null;
  /** Decisions the reader changed after the first run. */
  fixes: Decision[];
  /** Edits to code outside the adapter. Always 0: the point of the pattern. */
  callerEdits: 0;
}

export type Action =
  | { type: "guess"; guess: Guess }
  | { type: "run" }
  | { type: "set"; decision: Decision; value: string }
  | { type: "reset" };

export function init(): State {
  return { adapter: { ...NAIVE }, guess: null, run: null, first: null, fixes: [], callerEdits: 0 };
}

const VALUES: Record<Decision, string[]> = { amount: ["fixed2", "exponent"], status: ["okOrError", "mapped"], errors: ["raw", "wrapped"], retry: ["none", "lookup"] };

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.run ? st : { ...st, guess: a.guess };
    case "run": {
      if (st.run) return st;
      const run = simulate(st.adapter);
      return { ...st, run, first: run };
    }
    case "set": {
      if (!VALUES[a.decision].includes(a.value) || st.adapter[a.decision] === a.value) return st;
      const adapter = { ...st.adapter, [a.decision]: a.value } as Adapter;
      const fixes = st.fixes.includes(a.decision) ? st.fixes : [...st.fixes, a.decision];
      return { ...st, adapter, fixes: st.run ? fixes : st.fixes, run: st.run ? simulate(adapter) : null };
    }
  }
}
