// Purpose: after this, the reader can answer: "Which checks move a value from unknown to the exact
// type my code needs, and where does the compiler's narrowed type stop matching what is really
// in memory?"
//
// A webhook handler drawn as a control-flow graph, one statement per row. The reader adds checks
// (instanceof, typeof, in, a user-defined guard, equality, a null check) and watches the type of
// `body` change after each one, while the compile errors at the bottom disappear. Seven real
// payloads run through the same graph as plain JavaScript (types erased), so the reader sees which
// ones end in 400, 200, an email, or a crash.
//
// Then the break-it controls: a plugin hook that sets customer to null inside a callback, which
// narrowing cannot see (the compiler assumes calls do not undo a narrowing), and a guard whose body
// checks less than its `x is PaymentEvent` signature claims (predicates are trusted, not verified).
//
// Plain state + a pure step function, so it can be tested without a browser.

export type CheckId = "instanceof" | "typeof" | "in" | "guard" | "equality" | "null";
export const CHECKS: CheckId[] = ["instanceof", "typeof", "in", "guard", "equality", "null"];

export const CHECK: Record<CheckId, { label: string; code: string; exit: string; what: string }> = {
  instanceof: { label: "instanceof", code: "if (err instanceof SyntaxError) return badRequest(err.message);", exit: "400",
    what: "In a catch block err is unknown. instanceof narrows it to SyntaxError, which has a message." },
  typeof: { label: "typeof", code: 'if (typeof body !== "object" || body === null) return badRequest();', exit: "400",
    what: 'typeof narrows unknown to object. The null test is needed because typeof null is "object".' },
  in: { label: "in", code: 'if (!("type" in body) || typeof body.type !== "string") return badRequest();', exit: "400",
    what: '"type" in body adds a type property to what the compiler knows (TypeScript 4.9+), and typeof narrows that property to string.' },
  guard: { label: "type guard", code: "if (!isPaymentEvent(body)) return badRequest();", exit: "400",
    what: "isPaymentEvent(x): x is PaymentEvent. When it returns true the compiler takes its word for it." },
  equality: { label: "equality", code: 'if (body.type !== "payment.failed") return ok();', exit: "200",
    what: "Comparing the type tag to a literal removes every union member with a different tag." },
  null: { label: "null check", code: "if (body.data.customer === null) return ok();", exit: "200",
    what: "=== null removes null from the customer property, so .email is safe to read." },
};

export type PayloadId = "succeeded" | "failed" | "guest" | "erased" | "partial" | "ping" | "broken";
export const PAYLOADS: PayloadId[] = ["succeeded", "failed", "guest", "erased", "partial", "ping", "broken"];

interface Customer { id: string; email: string }
interface Body { type?: unknown; data?: { invoiceId?: string; customer?: Customer | null; failureCode?: string } }

export const PAYLOAD: Record<PayloadId, { label: string; json: string; value: Body | string | null; correct: Outcome["kind"] }> = {
  succeeded: { label: "payment succeeded", correct: "ignored",
    json: '{"type":"payment.succeeded","data":{"invoiceId":"in_81","customer":{"id":"cus_7","email":"ana@acme.io"}}}',
    value: { type: "payment.succeeded", data: { invoiceId: "in_81", customer: { id: "cus_7", email: "ana@acme.io" } } } },
  failed: { label: "payment failed", correct: "emailed",
    json: '{"type":"payment.failed","data":{"invoiceId":"in_82","customer":{"id":"cus_9","email":"li@shop.dev"},"failureCode":"card_declined"}}',
    value: { type: "payment.failed", data: { invoiceId: "in_82", customer: { id: "cus_9", email: "li@shop.dev" }, failureCode: "card_declined" } } },
  guest: { label: "failed, guest checkout", correct: "ignored",
    json: '{"type":"payment.failed","data":{"invoiceId":"in_83","customer":null,"failureCode":"expired_card"}}',
    value: { type: "payment.failed", data: { invoiceId: "in_83", customer: null, failureCode: "expired_card" } } },
  erased: { label: "failed, customer asked for erasure", correct: "emailed",
    json: '{"type":"payment.failed","data":{"invoiceId":"in_84","customer":{"id":"cus_3","email":"jo@mail.eu"},"failureCode":"card_declined"}}',
    value: { type: "payment.failed", data: { invoiceId: "in_84", customer: { id: "cus_3", email: "jo@mail.eu" }, failureCode: "card_declined" } } },
  partial: { label: "truncated event", correct: "rejected", json: '{"type":"payment.failed"}', value: { type: "payment.failed" } },
  ping: { label: "provider ping", correct: "rejected", json: '"ping"', value: "ping" },
  broken: { label: "not JSON", correct: "rejected", json: '{"type":"payment.fa', value: null },
};

/** The customer whose data the GDPR plugin removes. */
export const ERASED_CUSTOMER = "cus_3";

/* ---------------- state ---------------- */

export type Predict = "flags" | "silent" | "refuses";
export const PREDICT_ANSWER: Predict = "silent";

export type ChallengeId = "compile" | "allCorrect" | "callback" | "liar" | "fixed";

export interface State {
  checks: CheckId[];
  /** a plugin hook runs between the null check and the email */
  hook: boolean;
  /** check customer again after the plugins ran */
  recheck: boolean;
  /** isPaymentEvent only checks that type is a string */
  guardLies: boolean;
  payload: PayloadId;
  predict: Predict | null;
  done: ChallengeId[];
}

export type Action =
  | { type: "toggle"; check: CheckId }
  | { type: "hook"; on: boolean }
  | { type: "recheck"; on: boolean }
  | { type: "guardLies"; on: boolean }
  | { type: "payload"; id: PayloadId }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { checks: [], hook: false, recheck: false, guardLies: false, payload: "failed", predict: null, done: [] };
}

/* ---------------- the compiler's view ---------------- */

export type Point = "parse" | CheckId | "hook" | "recheck" | "use";
export interface Row { point: Point; type: string; error: string | null }

const has = (s: Pick<State, "checks">, c: CheckId) => s.checks.includes(c);

/**
 * The type of `body` the compiler believes after each row, and any error it reports on that row.
 * Rows for checks the reader has not added are omitted.
 */
export function analyse(s: Pick<State, "checks" | "hook" | "recheck">): Row[] {
  const rows: Row[] = [];
  let t: "unknown" | "object" | "hasType" | "event" | "failed" = "unknown";
  let customerNarrowed = false;
  const show = () => {
    switch (t) {
      case "unknown": return "unknown";
      case "object": return "object";
      case "hasType": return 'object & Record<"type", unknown>; body.type: string';
      case "event": return customerNarrowed ? "PaymentEvent; body.data.customer: Customer" : "PaymentSucceeded | PaymentFailed";
      case "failed": return customerNarrowed ? "PaymentFailed; body.data.customer: Customer" : "PaymentFailed";
    }
  };
  rows.push({ point: "parse", type: "unknown", error: has(s, "instanceof") ? null : "'err' is of type 'unknown'. (on err.message in the catch block)" });
  if (has(s, "instanceof")) rows.push({ point: "instanceof", type: "unknown", error: null });
  if (has(s, "typeof")) { t = "object"; rows.push({ point: "typeof", type: show(), error: null }); }
  if (has(s, "in")) {
    if (t === "unknown") rows.push({ point: "in", type: show(), error: "'body' is of type 'unknown'. (the right side of in must be an object)" });
    else { t = "hasType"; rows.push({ point: "in", type: show(), error: null }); }
  }
  if (has(s, "guard")) { t = "event"; rows.push({ point: "guard", type: show(), error: null }); }
  if (has(s, "equality")) {
    if (t === "event") { t = "failed"; rows.push({ point: "equality", type: show(), error: null }); }
    else if (t === "hasType") rows.push({ point: "equality", type: show(), error: null });
    else rows.push({ point: "equality", type: show(), error: t === "unknown" ? "'body' is of type 'unknown'." : "Property 'type' does not exist on type 'object'." });
  }
  if (has(s, "null")) {
    if (t === "event" || t === "failed") { customerNarrowed = true; rows.push({ point: "null", type: show(), error: null }); }
    else rows.push({ point: "null", type: show(), error: t === "unknown" ? "'body' is of type 'unknown'." : `Property 'data' does not exist on type '${t === "object" ? "object" : 'object & Record<"type", unknown>'}'.` });
  }
  // The plugin call: the compiler assumes a function call does not undo a narrowing.
  if (s.hook) rows.push({ point: "hook", type: show(), error: null });
  if (s.hook && s.recheck) {
    if (t === "event" || t === "failed") rows.push({ point: "recheck", type: show(), error: null });
    else rows.push({ point: "recheck", type: show(), error: "'body' is of type 'unknown'." });
  }
  // The use: mailer.paymentFailed(body.data.customer.email, body.data.failureCode)
  let useErr: string | null = null;
  if (t === "unknown") useErr = "'body' is of type 'unknown'.";
  else if (t === "object" || t === "hasType") useErr = `Property 'data' does not exist on type '${t === "object" ? "object" : 'object & Record<"type", unknown>'}'.`;
  else if (t === "event") useErr = "Property 'failureCode' does not exist on type 'PaymentEvent'. It does not exist on PaymentSucceeded.";
  else if (!customerNarrowed) useErr = "'body.data.customer' is possibly 'null'.";
  rows.push({ point: "use", type: show(), error: useErr });
  return rows;
}

export const compileErrors = (s: Pick<State, "checks" | "hook" | "recheck">) => analyse(s).filter((r) => r.error).length;

/* ---------------- the runtime's view (types erased) ---------------- */

export interface Outcome {
  kind: "rejected" | "ignored" | "emailed" | "wrongEmail" | "crash";
  /** the row where it ended */
  at: Point;
  text: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function honestGuard(v: unknown): boolean {
  if (!isObj(v) || (v.type !== "payment.succeeded" && v.type !== "payment.failed")) return false;
  const d = v.data;
  if (!isObj(d) || typeof d.invoiceId !== "string") return false;
  const c = d.customer;
  if (c !== null && !(isObj(c) && typeof c.email === "string")) return false;
  return v.type === "payment.succeeded" || typeof d.failureCode === "string";
}
const lyingGuard = (v: unknown) => isObj(v) && typeof v.type === "string";

/** Run one payload through the handler as JavaScript. Returns the rows it passed and how it ended. */
export function run(s: Pick<State, "checks" | "hook" | "recheck" | "guardLies">, id: PayloadId): { path: Point[]; outcome: Outcome } {
  const path: Point[] = ["parse"];
  const end = (kind: Outcome["kind"], at: Point, text: string) => ({ path, outcome: { kind, at, text } });
  const p = PAYLOAD[id];
  if (id === "broken") {
    if (has(s, "instanceof")) path.push("instanceof");
    return end("rejected", "parse", "JSON.parse throws a SyntaxError; the catch block answers 400.");
  }
  // a fresh copy, so plugins can mutate it
  const body: unknown = JSON.parse(p.json);
  if (has(s, "typeof")) {
    path.push("typeof");
    if (!isObj(body)) return end("rejected", "typeof", `typeof "ping" is "string", so the handler answers 400.`);
  }
  if (has(s, "in")) {
    path.push("in");
    if (!isObj(body)) return end("crash", "in", `TypeError: Cannot use 'in' operator to search for 'type' in ping. The compiler flagged this line.`);
    if (typeof body.type !== "string") return end("rejected", "in", "No string type field: 400.");
  }
  if (has(s, "guard")) {
    path.push("guard");
    if (!(s.guardLies ? lyingGuard(body) : honestGuard(body))) return end("rejected", "guard", "isPaymentEvent returns false: 400.");
  }
  const b = body as Body;
  if (has(s, "equality")) {
    path.push("equality");
    if (typeof body === "string" || b.type !== "payment.failed") return end("ignored", "equality", `type is ${typeof body === "string" ? "undefined" : JSON.stringify(b.type)}, not "payment.failed": 200, nothing to do.`);
  }
  if (has(s, "null")) {
    path.push("null");
    if (typeof body === "string" || b.data === undefined) return end("crash", "null", "TypeError: Cannot read properties of undefined (reading 'customer'). The event has no data.");
    if (b.data.customer === null) return end("ignored", "null", "Guest checkout, no customer to email: 200.");
  }
  if (s.hook) {
    path.push("hook");
    // the GDPR plugin, running inside forEach: plugins.forEach(p => p.beforeEmail(body))
    if (typeof body !== "string" && b.data?.customer && b.data.customer.id === ERASED_CUSTOMER) b.data.customer = null;
  }
  if (s.hook && s.recheck) {
    path.push("recheck");
    if (typeof body !== "string" && b.data && b.data.customer === null) return end("ignored", "recheck", "A plugin removed the customer; checked again, so no email: 200.");
  }
  path.push("use");
  if (typeof body === "string" || b.data === undefined) return end("crash", "use", "TypeError: Cannot read properties of undefined (reading 'customer'). The handler answers 500 and the provider retries it.");
  if (b.data.customer === null || b.data.customer === undefined) {
    const why = s.hook && id === "erased" ? " The plugin set it to null inside a callback, after the null check." : "";
    return end("crash", "use", `TypeError: Cannot read properties of null (reading 'email').${why} The handler answers 500 and the provider retries it.`);
  }
  if (b.type !== "payment.failed") return end("wrongEmail", "use", `Emailed ${b.data.customer.email} that their payment failed, with code ${b.data.failureCode}. It succeeded.`);
  return end("emailed", "use", `Emailed ${b.data.customer.email}: payment failed (${b.data.failureCode}).`);
}

/** Is this outcome what the business wanted? */
export function correct(s: Pick<State, "hook">, id: PayloadId, o: Outcome): boolean {
  if (id === "erased" && s.hook) return o.kind === "ignored";
  return o.kind === PAYLOAD[id].correct;
}

export interface Tally { errors: number; crashes: number; wrongEmails: number; correct: number }
export function tally(s: Pick<State, "checks" | "hook" | "recheck" | "guardLies">): Tally {
  const outs = PAYLOADS.map((id) => ({ id, o: run(s, id).outcome }));
  return {
    errors: compileErrors(s),
    crashes: outs.filter((x) => x.o.kind === "crash").length,
    wrongEmails: outs.filter((x) => x.o.kind === "wrongEmail").length,
    correct: outs.filter((x) => correct(s, x.id, x.o)).length,
  };
}

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "compile", text: "Add checks until the compiler reports zero errors." },
  { id: "allCorrect", text: "Make all seven payloads end correctly, with zero compile errors." },
  { id: "callback", text: "Install the plugin hook. Find the payload that crashes while the compiler reports zero errors." },
  { id: "liar", text: "Make the guard lie. Find the payload it lets through that then crashes." },
  { id: "fixed", text: "With the plugin installed and an honest guard: zero errors and seven correct outcomes." },
];

function satisfied(s: State): ChallengeId[] {
  const t = tally(s);
  const o = run(s, s.payload).outcome;
  const out: ChallengeId[] = [];
  if (t.errors === 0) out.push("compile");
  if (t.errors === 0 && t.correct === PAYLOADS.length) out.push("allCorrect");
  if (s.hook && t.errors === 0 && s.payload === "erased" && o.kind === "crash") out.push("callback");
  if (s.guardLies && s.payload === "partial" && o.kind === "crash") out.push("liar");
  if (s.hook && !s.guardLies && t.errors === 0 && t.correct === PAYLOADS.length) out.push("fixed");
  return out;
}

function record(s: State): State {
  const add = satisfied(s).filter((c) => !s.done.includes(c));
  return add.length ? { ...s, done: [...s.done, ...add] } : s;
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "toggle": {
      const on = s.checks.includes(a.check);
      const checks = on ? s.checks.filter((c) => c !== a.check) : CHECKS.filter((c) => c === a.check || s.checks.includes(c));
      return record({ ...s, checks });
    }
    case "hook": return record({ ...s, hook: a.on, recheck: a.on ? s.recheck : false });
    case "recheck": return record({ ...s, recheck: s.hook && a.on });
    case "guardLies": return record({ ...s, guardLies: a.on });
    case "payload": return record({ ...s, payload: a.id });
    case "predict": return s.hook ? s : { ...s, predict: a.value };
  }
}
