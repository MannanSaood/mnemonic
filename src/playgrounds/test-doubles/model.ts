// Purpose. After this, the reader can answer: "Which kind of test double should stand in for each
// dependency, and why does verifying the calls a service makes to get data catch no extra bugs but
// break the tests when someone refactors?"
//
// The model: one service, SendReceipt, with two dependencies.
// - OrderRepo answers queries (getOrder, getCustomer): data flows in.
// - Mailer receives a command (send): an email leaves the system.
// The reader picks a double for each slot (dummy, stub, spy, mock or fake). A two-test suite is
// written against today's code with those doubles. Then the reader runs the suite against the
// correct code, against five planted bugs, and against three refactorings that change nothing a
// customer could notice. The service is really executed against the doubles: each double answers,
// records, throws or verifies exactly as its kind does, and each test's assertions are evaluated.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Kind = "dummy" | "stub" | "spy" | "mock" | "fake";
export const KINDS: Kind[] = ["dummy", "stub", "spy", "mock", "fake"];
export type Slot = "repo" | "mailer";

export const KIND_NOTE: Record<Kind, { name: string; repo: string; mailer: string }> = {
  dummy: { name: "Dummy", repo: "Fills the parameter. Fails the test if the code ever calls it.", mailer: "Fills the parameter. Fails the test if the code ever calls it." },
  stub: { name: "Stub", repo: "Canned answers, set up in each test for the calls the code makes today. Never checked.", mailer: "Says the send worked. Records nothing, so the test cannot see the email." },
  spy: { name: "Spy", repo: "Canned answers, and records every call. The test then asserts the calls it saw.", mailer: "Records every email. The test asserts the list of emails sent." },
  mock: { name: "Mock", repo: "Expects exactly the calls the code made when the test was written. Anything else fails.", mailer: "Expects exactly one send with this email. Anything else fails." },
  fake: { name: "Fake", repo: "A working in-memory repository with every method. The test asserts nothing on it.", mailer: "An in-memory outbox. The test reads what landed in it." },
};

export type ScenarioId = "correct" | "b1" | "b2" | "b3" | "b4" | "b5" | "r1" | "r2" | "r3";
export interface Scenario { id: ScenarioId; kind: "base" | "bug" | "refactor"; title: string; what: string }
export const SCENARIOS: Scenario[] = [
  { id: "correct", kind: "base", title: "Today's code", what: "The service as it is. Every test should pass." },
  { id: "b1", kind: "bug", title: "Forgets to send", what: "A merge dropped the line that sends the email." },
  { id: "b2", kind: "bug", title: "Wrong address", what: "The receipt goes to the order's billing contact, not the customer." },
  { id: "b3", kind: "bug", title: "Sends twice", what: "A retry wrapper sends the receipt a second time after a slow reply." },
  { id: "b4", kind: "bug", title: "Tax left out", what: "The total in the email is the subtotal, without tax." },
  { id: "b5", kind: "bug", title: "Missing order", what: "An unknown order id sends an empty $0.00 receipt instead of returning an error." },
  { id: "r1", kind: "refactor", title: "Load the order once", what: "The order was loaded twice; now it is loaded once. Same email." },
  { id: "r2", kind: "refactor", title: "One joined query", what: "getOrder plus getCustomer becomes getOrderWithCustomer. Same email." },
  { id: "r3", kind: "refactor", title: "Shared template", what: "The email is built with the shared receipt template. Same bytes sent." },
];
export const BUG_IDS = SCENARIOS.filter((s) => s.kind === "bug").map((s) => s.id);
export const REFACTOR_IDS = SCENARIOS.filter((s) => s.kind === "refactor").map((s) => s.id);

// ---------------------------------------------------------------- the service under test

interface Order { id: string; customerId: string; billingEmail: string; subtotalCents: number; taxCents: number }
interface Customer { id: string; email: string }
export interface Email { to: string; subject: string; body: string }

const ORDERS: Record<string, Order> = {
  ord_42: { id: "ord_42", customerId: "cus_7", billingEmail: "accounts@example.com", subtotalCents: 10000, taxCents: 700 },
};
const CUSTOMERS: Record<string, Customer> = { cus_7: { id: "cus_7", email: "ana@example.com" } };

interface Repo {
  getOrder(id: string): Order | null;
  getCustomer(id: string): Customer | null;
  getOrderWithCustomer(id: string): { order: Order; customer: Customer } | null;
}
interface Mailer { send(e: Email): void }

/** A double failed the test while the service was running (dummy touched, mock surprised). */
class TestFailure extends Error {}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const fmt = (e: Email) => `send(to=${e.to || '""'}, "${e.body}")`;

/** SendReceipt, in one of the scenario variants. Returns "ok" or an error message. */
function sendReceipt(v: ScenarioId, id: string, repo: Repo, mailer: Mailer): { ok: true } | { ok: false; error: string } {
  let order: Order, customer: Customer;
  if (v === "r2") {
    const oc = repo.getOrderWithCustomer(id);
    if (!oc) return { ok: false, error: "order not found" };
    ({ order, customer } = oc);
  } else {
    const first = repo.getOrder(id); // validate
    if (!first) {
      if (v === "b5") { mailer.send({ to: "", subject: `Receipt for order ${id}`, body: "Total: $0.00" }); return { ok: true }; }
      return { ok: false, error: "order not found" };
    }
    const again = v === "r1" ? first : repo.getOrder(id); // build: today's code loads it a second time
    if (!again) return { ok: false, error: "order not found" };
    order = again;
    const c = repo.getCustomer(order.customerId);
    if (!c) return { ok: false, error: "customer not found" };
    customer = c;
  }
  const total = order.subtotalCents + (v === "b4" ? 0 : order.taxCents);
  const email: Email = { to: v === "b2" ? order.billingEmail : customer.email, subject: `Receipt for order ${id}`, body: `Total: ${money(total)}` };
  if (v !== "b1") mailer.send(email);
  if (v === "b3") mailer.send(email);
  return { ok: true };
}

// ---------------------------------------------------------------- the two tests and the doubles

export type TestId = "t1" | "t2";
export const TESTS: Record<TestId, { name: string; orderId: string }> = {
  t1: { name: "sends the receipt for order ord_42", orderId: "ord_42" },
  t2: { name: "unknown order: returns an error, sends nothing", orderId: "ord_99" },
};
const EXPECTED_EMAIL: Email = { to: "ana@example.com", subject: "Receipt for order ord_42", body: "Total: $107.00" };
/** The repo calls today's code makes, which a spy or mock test was written to expect. */
const REPO_CALLS_TODAY: Record<TestId, string[]> = {
  t1: ["getOrder(ord_42)", "getOrder(ord_42)", "getCustomer(cus_7)"],
  t2: ["getOrder(ord_99)"],
};
const EMAILS_EXPECTED: Record<TestId, Email[]> = { t1: [EXPECTED_EMAIL], t2: [] };

export interface Call { who: Slot; text: string; ok: boolean }
export interface TestRun { test: TestId; pass: boolean; calls: Call[]; reason: string }

function makeRepo(kind: Kind, test: TestId, calls: Call[]): Repo {
  const log = (text: string, ok = true) => calls.push({ who: "repo", text, ok });
  // What a test configures for the calls the code makes today (stub, spy, mock): only these methods.
  const canned = (method: string, id: string) => {
    if (method === "getOrder") return ORDERS[id] ?? null;
    if (method === "getCustomer") return CUSTOMERS[id] ?? null;
    return null; // nothing configured for any other method
  };
  const call = (method: "getOrder" | "getCustomer" | "getOrderWithCustomer", id: string): unknown => {
    const text = `${method}(${id})`;
    switch (kind) {
      case "dummy":
        log(text, false);
        throw new TestFailure(`The dummy repository was called: ${text}. A dummy only fills a parameter the code never uses.`);
      case "fake": {
        log(text);
        if (method === "getOrder") return ORDERS[id] ?? null;
        if (method === "getCustomer") return CUSTOMERS[id] ?? null;
        const o = ORDERS[id];
        return o ? { order: o, customer: CUSTOMERS[o.customerId] } : null;
      }
      case "mock": {
        const expected = REPO_CALLS_TODAY[test];
        const made = calls.filter((c) => c.who === "repo").length;
        if (expected[made] !== text) {
          log(text, false);
          throw new TestFailure(`Unexpected call ${text}. The mock expected ${expected[made] ?? "no more calls"}.`);
        }
        log(text);
        return canned(method, id);
      }
      default: { // stub, spy
        const v = canned(method, id);
        log(text + (v === null && method === "getOrderWithCustomer" ? " → nothing configured" : ""), !(v === null && method === "getOrderWithCustomer"));
        return v;
      }
    }
  };
  return {
    getOrder: (id) => call("getOrder", id) as Order | null,
    getCustomer: (id) => call("getCustomer", id) as Customer | null,
    getOrderWithCustomer: (id) => call("getOrderWithCustomer", id) as { order: Order; customer: Customer } | null,
  };
}

function makeMailer(kind: Kind, test: TestId, calls: Call[], sent: Email[]): Mailer {
  return {
    send(e) {
      const text = fmt(e);
      if (kind === "dummy") {
        calls.push({ who: "mailer", text, ok: false });
        throw new TestFailure(`The dummy mailer was called: ${text}. A dummy only fills a parameter the code never uses.`);
      }
      if (kind === "mock") {
        const expected = EMAILS_EXPECTED[test];
        const i = sent.length;
        if (!expected[i] || !same(expected[i], e)) {
          calls.push({ who: "mailer", text, ok: false });
          throw new TestFailure(expected[i] ? `Unexpected ${text}. The mock expected ${fmt(expected[i])}.` : `Unexpected ${text}. The mock expected no more emails.`);
        }
      }
      calls.push({ who: "mailer", text, ok: true });
      sent.push(e);
    },
  };
}

const same = (a: Email, b: Email) => a.to === b.to && a.subject === b.subject && a.body === b.body;

function runTest(test: TestId, v: ScenarioId, repoKind: Kind, mailerKind: Kind): TestRun {
  const calls: Call[] = [];
  const sent: Email[] = [];
  const repo = makeRepo(repoKind, test, calls);
  const mailer = makeMailer(mailerKind, test, calls, sent);
  const fail = (reason: string): TestRun => ({ test, pass: false, calls, reason });
  let result: ReturnType<typeof sendReceipt>;
  try {
    result = sendReceipt(v, TESTS[test].orderId, repo, mailer);
  } catch (e) {
    if (e instanceof TestFailure) return fail(e.message);
    throw e;
  }
  // The test's own assertion on the return value.
  if (test === "t1" && !result.ok) return fail(`The service returned "${result.error}"${repoKind === "stub" || repoKind === "spy" ? ": the test never configured an answer for that call" : ""}.`);
  if (test === "t2" && result.ok) return fail("The service returned success for an order that does not exist.");
  // Verification of the repo double.
  const repoCalls = calls.filter((c) => c.who === "repo").map((c) => c.text);
  const want = REPO_CALLS_TODAY[test];
  if ((repoKind === "spy" || repoKind === "mock") && (repoCalls.length !== want.length || repoCalls.some((c, i) => c !== want[i])))
    return fail(repoKind === "mock"
      ? `The mock's expectations were not met: it wanted ${want.join(", ")}; the code made ${repoCalls.join(", ") || "no calls"}.`
      : `The spy recorded ${repoCalls.join(", ") || "no calls"}; the test asserts ${want.join(", ")}.`);
  // Verification of the mailer double.
  const wantMail = EMAILS_EXPECTED[test];
  if (mailerKind === "spy" || mailerKind === "mock" || mailerKind === "fake") {
    const ok = sent.length === wantMail.length && sent.every((e, i) => same(e, wantMail[i]));
    if (!ok) {
      const got = sent.length ? sent.map(fmt).join(" and ") : "no email";
      const exp = wantMail.length ? fmt(wantMail[0]) : "no email";
      const who = mailerKind === "mock" ? "The mock expected" : mailerKind === "spy" ? "The spy recorded " + got + "; the test expects" : "The outbox holds " + got + "; the test expects";
      return fail(mailerKind === "mock" ? `${who} ${exp}; the code sent ${got}.` : `${who} ${exp}.`);
    }
  }
  return { test, pass: true, calls, reason: mailerKind === "stub" && test === "t1" ? "Passed. The stub mailer kept no record, so the test only checked that the call returned without an error." : "Passed." };
}

export interface ScenarioRun { scenario: ScenarioId; tests: TestRun[]; red: boolean }

export function runScenario(v: ScenarioId, repo: Kind, mailer: Kind): ScenarioRun {
  const tests = (["t1", "t2"] as TestId[]).map((t) => runTest(t, v, repo, mailer));
  return { scenario: v, tests, red: tests.some((t) => !t.pass) };
}

/** What a run means: for a bug, red is good (caught); for today's code or a refactor, red is a false alarm. */
export type Verdict = "green" | "broken" | "caught" | "missed" | "false-alarm";
export function verdict(r: ScenarioRun): Verdict {
  const k = SCENARIOS.find((s) => s.id === r.scenario)!.kind;
  if (k === "base") return r.red ? "broken" : "green";
  if (k === "bug") return r.red ? "caught" : "missed";
  return r.red ? "false-alarm" : "green";
}

// ---------------------------------------------------------------- state

export interface Tally { repo: Kind; mailer: Kind; caught: number; falseAlarms: number; broken: boolean }

export interface State {
  repo: Kind;
  mailer: Kind;
  /** Runs for the current pair of doubles, by scenario. Cleared when a double changes. */
  runs: Partial<Record<ScenarioId, ScenarioRun>>;
  selected: ScenarioId | null;
  /** Every pair the reader has run against all nine scenarios. */
  history: Tally[];
  /** Repo kinds the reader has seen run against all scenarios (with a working mailer double). */
  predict: Predict | null;
}

export type Predict = "mock" | "fake" | "same";
export const PREDICT_ANSWER: Predict = "same";

export type Action =
  | { type: "pick"; slot: Slot; kind: Kind }
  | { type: "run"; scenario: ScenarioId }
  | { type: "runAll" }
  | { type: "select"; scenario: ScenarioId }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { repo: "mock", mailer: "mock", runs: {}, selected: null, history: [], predict: null };
}

export function tallyOf(st: Pick<State, "repo" | "mailer" | "runs">): Tally | null {
  const all = SCENARIOS.every((s) => st.runs[s.id]);
  if (!all) return null;
  const vs = SCENARIOS.map((s) => verdict(st.runs[s.id]!));
  return {
    repo: st.repo, mailer: st.mailer,
    caught: vs.filter((v) => v === "caught").length,
    falseAlarms: vs.filter((v) => v === "false-alarm").length,
    broken: vs.includes("broken"),
  };
}

function remember(st: State): State {
  const t = tallyOf(st);
  if (!t) return st;
  const history = [t, ...st.history.filter((h) => !(h.repo === t.repo && h.mailer === t.mailer))];
  return { ...st, history };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return { ...st, predict: a.value };
    case "pick":
      if (st[a.slot] === a.kind) return st;
      return { ...st, [a.slot]: a.kind, runs: {}, selected: null };
    case "select":
      return { ...st, selected: a.scenario };
    case "run":
      return remember({ ...st, runs: { ...st.runs, [a.scenario]: runScenario(a.scenario, st.repo, st.mailer) }, selected: a.scenario });
    case "runAll": {
      const runs: State["runs"] = {};
      for (const s of SCENARIOS) runs[s.id] = runScenario(s.id, st.repo, st.mailer);
      return remember({ ...st, runs, selected: st.selected ?? "r1" });
    }
  }
}

/** The prediction is revealed once the reader has full results for two working repo doubles. */
export function predictRevealed(st: State): boolean {
  const repos = new Set(st.history.filter((h) => !h.broken).map((h) => h.repo));
  return repos.size >= 2;
}

export function challenges(st: State) {
  const h = st.history;
  return [
    { id: "best", text: "Catch all 5 bugs with 0 false alarms.", done: h.some((t) => t.caught === 5 && t.falseAlarms === 0 && !t.broken) },
    { id: "wolf", text: "Find a pair that catches every bug and still cries wolf on a refactoring.", done: h.some((t) => t.caught === 5 && t.falseAlarms > 0 && !t.broken) },
    { id: "stub", text: "Use a stub as the mailer. Which bugs slip through?", done: h.some((t) => t.mailer === "stub") },
    { id: "dummy", text: "Put a dummy in a slot and see what it is for.", done: h.some((t) => t.repo === "dummy" || t.mailer === "dummy") },
  ];
}
