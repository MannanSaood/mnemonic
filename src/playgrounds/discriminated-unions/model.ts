// Purpose: after this, the reader can answer: "When I add a new state, how do I find every piece of
// code that must handle it, and why does a tagged union with an exhaustive switch find them for
// me when optional fields do not?"
//
// One payment model, written twice: a tagged union (one member per status, each with exactly its
// fields) and a bag of optional fields. Five real functions in five files read it. The reader adds
// the 3-D Secure state, requires_action, to both. The union side lights up every switch that ends in
// assertNever; the optional side compiles cleanly. Then the reader ships, and a 3-D Secure payment
// runs through every function in both versions: the optional version ships unpaid goods and never
// asks the customer to verify. Break-it: turn exhaustive switches into `default:` branches and watch
// the union side go just as quiet.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type FuncId = "readyToShip" | "statusLabel" | "canRefund" | "receiptLine" | "shouldRetry";
export const FUNCS: FuncId[] = ["readyToShip", "statusLabel", "canRefund", "receiptLine", "shouldRetry"];

export interface Func {
  file: string;
  sig: string;
  /** what it should do for a requires_action payment */
  right: string;
  /** the optional-fields version, and what it does for requires_action */
  optCode: string;
  optDoes: string;
  optOk: boolean;
  /** the union version's default branch, if it has one, and what that does for requires_action */
  defaultCode: string;
  defaultDoes: string;
  defaultOk: boolean;
  /** the new case a reader adds */
  newCase: string;
}

export const FUNC: Record<FuncId, Func> = {
  readyToShip: {
    file: "fulfillment/ready.ts", sig: "readyToShip(p: Payment): boolean",
    right: "false: wait until the bank confirms",
    optCode: "return !p.failureReason && !p.refundId;",
    optDoes: "true: the warehouse ships an order nobody has paid for", optOk: false,
    defaultCode: "default: return false;", defaultDoes: "false, by luck", defaultOk: true,
    newCase: 'case "requires_action": return false;',
  },
  statusLabel: {
    file: "ui/PaymentBadge.tsx", sig: "statusLabel(p: Payment): string",
    right: '"Verify with your bank" and a link to redirectUrl',
    optCode: 'if (p.refundId) return "Refunded"; … if (p.authCode) return "Authorized"; return "Processing";',
    optDoes: '"Processing": the customer is never asked to verify, and the payment expires', optOk: false,
    defaultCode: 'default: return "Processing";', defaultDoes: '"Processing": the customer is never asked to verify', defaultOk: false,
    newCase: 'case "requires_action": return "Verify with your bank";',
  },
  canRefund: {
    file: "support/refunds.ts", sig: "canRefund(p: Payment): boolean",
    right: "false: there is nothing to refund yet",
    optCode: "return p.capturedAt !== undefined && !p.refundId;",
    optDoes: "false, by luck: it happens to test a field the new state lacks", optOk: true,
    defaultCode: "default: return false;", defaultDoes: "false, by luck", defaultOk: true,
    newCase: 'case "requires_action": return false;',
  },
  receiptLine: {
    file: "email/receipt.ts", sig: "receiptLine(p: Payment): string",
    right: "a line with the verification link",
    optCode: 'return p.capturedAt ? "Charged" : p.failureReason ? "Declined" : "Pending";',
    optDoes: '"Pending": the email has no link, so the customer cannot finish paying', optOk: false,
    defaultCode: 'default: return "Pending";', defaultDoes: '"Pending": the email has no verification link', defaultOk: false,
    newCase: 'case "requires_action": return `Verify your payment: ${p.redirectUrl}`;',
  },
  shouldRetry: {
    file: "jobs/retry.ts", sig: "shouldRetry(p: Payment): boolean",
    right: "false: only the customer can complete it",
    optCode: 'return p.failureReason === "processor_unavailable";',
    optDoes: "false, by luck", optOk: true,
    defaultCode: "default: return false;", defaultDoes: "false, by luck", defaultOk: true,
    newCase: 'case "requires_action": return false;',
  },
};

/** The union's members before and after the change, and the optional fields. */
export const MEMBERS = ["pending", "authorized", "captured", "failed", "refunded"];
export const NEW_MEMBER = "requires_action";
export const OPTIONAL_FIELDS = ["authCode", "capturedAt", "failureReason", "refundId"];
export const NEW_FIELD = "redirectUrl";

export type Ending = "never" | "default";
export type Predict = "five" | "fourZero" | "zero";
export const PREDICT_ANSWER: Predict = "fourZero";

export type ChallengeId = "count" | "unflagged" | "shipUnion" | "shipOptional" | "silence";

export interface State {
  /** requires_action has been added to both models */
  added: boolean;
  /** how each union switch ends */
  ending: Record<FuncId, Ending>;
  /** union switches that gained a requires_action case */
  handled: FuncId[];
  /** optional-field functions the reader opened and read */
  audited: FuncId[];
  /** optional-field functions the reader fixed by hand */
  fixed: FuncId[];
  /** the change has been deployed and a 3-D Secure payment ran through it */
  shipped: boolean;
  /** what the union side looked like when it shipped */
  shippedUnion: { errors: number; wrong: number } | null;
  predict: Predict | null;
  done: ChallengeId[];
}

export type Action =
  | { type: "add" }
  | { type: "ending"; f: FuncId; ending: Ending }
  | { type: "handle"; f: FuncId }
  | { type: "audit"; f: FuncId }
  | { type: "fix"; f: FuncId }
  | { type: "ship" }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return {
    added: false,
    // The realistic starting point: four switches end in assertNever, one has a convenient default.
    ending: { readyToShip: "never", statusLabel: "default", canRefund: "never", receiptLine: "never", shouldRetry: "never" },
    handled: [], audited: [], fixed: [], shipped: false, shippedUnion: null, predict: null, done: [],
  };
}

/* ---------------- what the compiler and the runtime say ---------------- */

/** Union switches the compiler flags: they end in assertNever and lack the new case. */
export function unionErrors(s: Pick<State, "added" | "ending" | "handled">): FuncId[] {
  if (!s.added) return [];
  return FUNCS.filter((f) => s.ending[f] === "never" && !s.handled.includes(f));
}

export interface Outcome { ok: boolean; text: string }

/** What a requires_action payment gets from one union function. Null if the build fails. */
export function unionOutcome(s: Pick<State, "added" | "ending" | "handled">, f: FuncId): Outcome | null {
  if (unionErrors(s).length > 0) return null;
  if (s.handled.includes(f)) return { ok: true, text: FUNC[f].right };
  // ending is "default" here (a "never" ending without the case would have been an error)
  return { ok: FUNC[f].defaultOk, text: FUNC[f].defaultDoes };
}

export function optionalOutcome(s: Pick<State, "fixed">, f: FuncId): Outcome {
  if (s.fixed.includes(f)) return { ok: true, text: FUNC[f].right };
  return { ok: FUNC[f].optOk, text: FUNC[f].optDoes };
}

/** How many shapes each model can represent. */
export function shapes(s: Pick<State, "added">) {
  const fields = OPTIONAL_FIELDS.length + (s.added ? 1 : 0);
  return { union: MEMBERS.length + (s.added ? 1 : 0), optional: 2 ** fields };
}

export interface Tally {
  unionErrors: number;
  unionWrong: number;
  optionalWrong: number;
  /** functions edited on each side */
  unionEdited: number;
  optionalEdited: number;
  /** functions the reader had to open on the optional side */
  read: number;
}

export function tally(s: State): Tally {
  const u = FUNCS.map((f) => unionOutcome(s, f));
  return {
    unionErrors: unionErrors(s).length,
    unionWrong: s.added ? u.filter((o) => o && !o.ok).length : 0,
    optionalWrong: s.added ? FUNCS.filter((f) => !optionalOutcome(s, f).ok).length : 0,
    unionEdited: s.handled.length,
    optionalEdited: s.fixed.length,
    read: s.audited.length,
  };
}

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "count", text: "Add requires_action and compare the error counts on each side." },
  { id: "unflagged", text: "Find the union switch the compiler did not flag, and make it flag." },
  { id: "shipUnion", text: "Ship the union side with zero wrong outcomes." },
  { id: "shipOptional", text: "Ship the optional side with zero wrong outcomes. Count how many functions you had to read." },
  { id: "silence", text: "Break it: give every union switch a default branch, then ship. Watch the compiler go quiet." },
];

function satisfied(s: State): ChallengeId[] {
  const t = tally(s);
  const out: ChallengeId[] = [];
  if (s.added) out.push("count");
  if (s.added && s.ending.statusLabel === "never") out.push("unflagged");
  if (s.shipped && s.shippedUnion && s.shippedUnion.errors === 0 && s.shippedUnion.wrong === 0) out.push("shipUnion");
  if (s.shipped && s.added && t.optionalWrong === 0) out.push("shipOptional");
  if (s.shipped && s.added && FUNCS.every((f) => s.ending[f] === "default") && s.handled.length === 0) out.push("silence");
  return out;
}

function record(s: State): State {
  const add = satisfied(s).filter((c) => !s.done.includes(c));
  return add.length ? { ...s, done: [...s.done, ...add] } : s;
}

const withF = (list: FuncId[], f: FuncId) => (list.includes(f) ? list : FUNCS.filter((x) => x === f || list.includes(x)));

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "add": return s.added ? s : record({ ...s, added: true, shipped: false, shippedUnion: null });
    case "ending": return record({ ...s, ending: { ...s.ending, [a.f]: a.ending }, shipped: false, shippedUnion: null });
    case "handle": return s.added ? record({ ...s, handled: withF(s.handled, a.f), shipped: false, shippedUnion: null }) : s;
    case "audit": return record({ ...s, audited: withF(s.audited, a.f) });
    case "fix": return s.added && s.audited.includes(a.f) ? record({ ...s, fixed: withF(s.fixed, a.f), shipped: false }) : s;
    case "ship": {
      if (!s.added) return s;
      const errors = unionErrors(s).length;
      const wrong = errors ? 0 : FUNCS.filter((f) => !unionOutcome(s, f)!.ok).length;
      return record({ ...s, shipped: true, shippedUnion: { errors, wrong } });
    }
    case "predict": return s.added ? s : { ...s, predict: a.value };
  }
}
