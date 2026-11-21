// Purpose. After this, the reader can answer: "What do guard clauses actually reduce?" They do not
// reduce the paths through a function (the behaviour is identical). They reduce what a reader must
// hold in mind on each line: how many conditions are open, and how far each check sits from the
// line that handles its failure. That is why a bug in the flat version is quicker to find.
//
// The model: a webhook handler with six checks (method, content type, signature, idempotency key,
// duplicate, event body), written as nested ifs. The reader turns each if into a guard clause,
// names the two compound conditions, and watches live metrics: nesting depth, cognitive complexity
// (SonarSource's rules), open else-branches at the main line, the farthest if-to-else distance,
// and the number of paths (constant). Eight request tests run after every step. A break-it
// control reorders two guards (a real behaviour change the tests catch). Then a bug hunt: the same
// kind of bug is planted in the nested and in the flat version and the reader's time and clicks
// to find each are recorded.
//
// Plain data + pure functions. Time comes in on actions, so the model stays testable.

export type CheckId = "method" | "type" | "sig" | "key" | "dup" | "body";
export type HelperId = "type" | "sig";

export interface Check {
  id: CheckId;
  label: string;
  cond: string;
  neg: string;
  helper?: { name: string; neg: string; def: string };
  status: number;
  reason: string;
  /** sequences of boolean operators in the raw condition (each adds 1 to cognitive complexity) */
  bools: number;
}

export const CHECKS: Check[] = [
  { id: "method", label: "method", cond: 'req.method === "POST"', neg: 'req.method !== "POST"', status: 405, reason: "use POST", bools: 0 },
  {
    id: "type", label: "content type", cond: 'ct === "application/json" || ct.startsWith("application/json;")',
    neg: '!(ct === "application/json" || ct.startsWith("application/json;"))',
    helper: { name: "isJson(ct)", neg: "!isJson(ct)", def: 'const isJson = (ct: string) => ct === "application/json" || ct.startsWith("application/json;");' },
    status: 415, reason: "send JSON", bools: 1,
  },
  {
    id: "sig", label: "signature", cond: 'sig !== "" && verifyHmac(sig, req.body) && ageMs(req) < FIVE_MIN',
    neg: '!(sig !== "" && verifyHmac(sig, req.body) && ageMs(req) < FIVE_MIN)',
    helper: { name: "validSignature(req)", neg: "!validSignature(req)", def: 'const validSignature = (req: Request) => sig(req) !== "" && verifyHmac(sig(req), req.body) && ageMs(req) < FIVE_MIN;' },
    status: 401, reason: "bad signature", bools: 1,
  },
  { id: "key", label: "idempotency key", cond: "key !== undefined", neg: "key === undefined", status: 400, reason: "missing Idempotency-Key", bools: 0 },
  { id: "dup", label: "duplicate", cond: "!seen.has(key)", neg: "seen.has(key)", status: 200, reason: "duplicate, ignored", bools: 0 },
  { id: "body", label: "event body", cond: "event !== null", neg: "event === null", status: 422, reason: "invalid event", bools: 0 },
];
export const CHECK = Object.fromEntries(CHECKS.map((c) => [c.id, c])) as Record<CheckId, Check>;
export const PATHS = CHECKS.length + 1;

export type Version = "nested" | "flat";
/** Each planted bug swaps the failure replies of two neighbouring checks. */
export const BUGS: Record<Version, [CheckId, CheckId]> = { nested: ["type", "sig"], flat: ["key", "dup"] };

export interface Shape {
  guarded: Record<CheckId, boolean>;
  extracted: Record<HelperId, boolean>;
  sigFirst: boolean;
  bug: Version | null;
}

/* ---------------- the code, generated from the shape ---------------- */

export type LineKind = "head" | "setup" | "if" | "guard" | "else" | "return" | "close" | "body" | "helper";
export interface Line { text: string; depth: number; kind: LineKind; check?: CheckId; buggy?: boolean }

export function order(s: Pick<Shape, "sigFirst">): CheckId[] {
  const ids = CHECKS.map((c) => c.id);
  return s.sigFirst ? ["sig", ...ids.filter((i) => i !== "sig")] : ids;
}

function reply(s: Shape, id: CheckId): { status: number; reason: string; buggy: boolean } {
  const pair = s.bug ? BUGS[s.bug] : null;
  if (pair && pair.includes(id)) {
    const other = CHECK[pair[0] === id ? pair[1] : pair[0]];
    return { status: other.status, reason: other.reason, buggy: true };
  }
  return { status: CHECK[id].status, reason: CHECK[id].reason, buggy: false };
}

const condText = (s: Shape, c: Check, negate: boolean) => {
  const named = c.helper && s.extracted[c.id as HelperId];
  if (named) return negate ? c.helper!.neg : c.helper!.name;
  return negate ? c.neg : c.cond;
};

export function render(s: Shape): Line[] {
  const out: Line[] = [];
  for (const c of CHECKS) if (c.helper && s.extracted[c.id as HelperId]) out.push({ text: c.helper.def, depth: 0, kind: "helper", check: c.id });
  if (out.length) out.push({ text: "", depth: 0, kind: "helper" });
  out.push({ text: "async function handleWebhook(req: Request): Promise<Reply> {", depth: 0, kind: "head" });
  out.push({ text: 'const ct = req.headers["content-type"] ?? "";', depth: 1, kind: "setup" });
  if (!s.extracted.sig) out.push({ text: 'const sig = req.headers["x-signature"] ?? "";', depth: 1, kind: "setup" });
  out.push({ text: 'const key = req.headers["idempotency-key"];', depth: 1, kind: "setup" });
  let depth = 1;
  const open: CheckId[] = [];
  for (const id of order(s)) {
    const c = CHECK[id];
    if (id === "body") out.push({ text: "const event = parseEvent(req.body);", depth, kind: "setup" });
    const r = reply(s, id);
    if (s.guarded[id]) {
      out.push({ text: `if (${condText(s, c, true)}) return reply(${r.status}, "${r.reason}");`, depth, kind: "guard", check: id, buggy: r.buggy });
    } else {
      out.push({ text: `if (${condText(s, c, false)}) {`, depth, kind: "if", check: id });
      open.push(id);
      depth++;
    }
  }
  out.push({ text: "await process(event);", depth, kind: "body" });
  out.push({ text: 'return reply(202, "accepted");', depth, kind: "body" });
  for (const id of [...open].reverse()) {
    depth--;
    const r = reply(s, id);
    out.push({ text: "} else {", depth, kind: "else", check: id });
    out.push({ text: `return reply(${r.status}, "${r.reason}");`, depth: depth + 1, kind: "return", check: id, buggy: r.buggy });
    out.push({ text: "}", depth, kind: "close", check: id });
  }
  out.push({ text: "}", depth: 0, kind: "close" });
  return out;
}

/* ---------------- metrics ---------------- */

export interface Metrics {
  /** how many ifs enclose the main line */
  depth: number;
  /** SonarSource cognitive complexity of handleWebhook itself */
  cognitive: number;
  /** cognitive complexity moved into the named helpers */
  helpers: number;
  /** else-branches still pending when you read the main line */
  openAtMain: number;
  /** the most lines between an if and the line that handles its failure */
  farthest: number;
  paths: number;
  lines: number;
}

export function metrics(s: Shape): Metrics {
  const ls = render(s);
  let nesting = 0;
  let cognitive = 0;
  let helpers = 0;
  for (const id of order(s)) {
    const c = CHECK[id];
    cognitive += 1 + nesting; // structural if, plus one per enclosing if
    if (!s.guarded[id]) { cognitive += 1; nesting++; } // the else (hybrid increment)
    const named = c.helper && s.extracted[c.id as HelperId];
    if (named) helpers += c.bools; else cognitive += c.bools;
  }
  let farthest = 0;
  ls.forEach((l, i) => {
    if (l.kind === "if") {
      const j = ls.findIndex((m, k) => k > i && m.kind === "return" && m.check === l.check);
      farthest = Math.max(farthest, j - i);
    }
  });
  const depth = order(s).filter((id) => !s.guarded[id]).length;
  return { depth, cognitive, helpers, openAtMain: depth, farthest, paths: PATHS, lines: ls.filter((l) => l.kind !== "helper").length };
}

/* ---------------- behaviour: eight requests ---------------- */

export interface Req { name: string; fails: CheckId[]; expect: number }
export const TESTS: Req[] = [
  { name: "GET request", fails: ["method"], expect: 405 },
  { name: "POST text/plain", fails: ["type"], expect: 415 },
  { name: "Forged signature", fails: ["sig"], expect: 401 },
  { name: "No Idempotency-Key", fails: ["key"], expect: 400 },
  { name: "Replayed key", fails: ["dup"], expect: 200 },
  { name: "Malformed event", fails: ["body"], expect: 422 },
  { name: "Valid event", fails: [], expect: 202 },
  { name: "GET with no signature", fails: ["method", "sig"], expect: 405 },
];

export function respond(s: Shape, t: Req): number {
  for (const id of order(s)) if (t.fails.includes(id)) return reply(s, id).status;
  return 202;
}

export interface TestResult { test: Req; got: number; ok: boolean }
export const runTests = (s: Shape): TestResult[] => TESTS.map((t) => { const got = respond(s, t); return { test: t, got, ok: got === t.expect }; });

/* ---------------- state ---------------- */

export interface HuntResult { ms: number; clicks: number }
export interface State extends Shape {
  /** refactoring steps applied, in order, for the history */
  steps: string[];
  /** test failures seen during refactoring */
  redRuns: number;
  hunt: { phase: Version | null; startedAt: number; clicks: number; wrong: number | null; nested?: HuntResult; flat?: HuntResult };
}

export type Action =
  | { type: "guard"; id: CheckId }
  | { type: "extract"; id: HelperId }
  | { type: "flattenAll" }
  | { type: "swap" }
  | { type: "hunt"; version: Version; at: number }
  | { type: "pick"; line: number; at: number }
  | { type: "reset" };

const none = <K extends string>(ids: K[]) => Object.fromEntries(ids.map((i) => [i, false])) as Record<K, boolean>;
const all = <K extends string>(ids: K[]) => Object.fromEntries(ids.map((i) => [i, true])) as Record<K, boolean>;
const IDS = CHECKS.map((c) => c.id);

export function init(): State {
  return {
    guarded: none(IDS), extracted: { type: false, sig: false }, sigFirst: false, bug: null,
    steps: [], redRuns: 0, hunt: { phase: null, startedAt: 0, clicks: 0, wrong: null },
  };
}

/** The fixed versions used for the bug hunt. */
export function huntShape(v: Version): Shape {
  return v === "nested"
    ? { guarded: none(IDS), extracted: { type: false, sig: false }, sigFirst: false, bug: "nested" }
    : { guarded: all(IDS), extracted: { type: true, sig: true }, sigFirst: false, bug: "flat" };
}

/** What the code panel shows: the hunt version while hunting, the reader's own otherwise. */
export function shown(s: State): Shape {
  return s.hunt.phase ? huntShape(s.hunt.phase) : s;
}

function afterEdit(s: State, step: string): State {
  const red = runTests(s).some((r) => !r.ok) ? 1 : 0;
  return { ...s, steps: [...s.steps, step], redRuns: s.redRuns + red };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guard": {
      if (s.hunt.phase) return s;
      const on = !s.guarded[a.id];
      return afterEdit({ ...s, guarded: { ...s.guarded, [a.id]: on } }, `${on ? "guard" : "nest"} ${CHECK[a.id].label}`);
    }
    case "extract": {
      if (s.hunt.phase) return s;
      const on = !s.extracted[a.id];
      return afterEdit({ ...s, extracted: { ...s.extracted, [a.id]: on } }, `${on ? "name" : "inline"} ${CHECK[a.id].label} condition`);
    }
    case "flattenAll":
      if (s.hunt.phase) return s;
      return afterEdit({ ...s, guarded: all(IDS), extracted: { type: true, sig: true } }, "flatten everything");
    case "swap":
      if (s.hunt.phase) return s;
      return afterEdit({ ...s, sigFirst: !s.sigFirst }, s.sigFirst ? "method check first again" : "check signature before method");
    case "hunt":
      return { ...s, hunt: { ...s.hunt, phase: a.version, startedAt: a.at, clicks: 0, wrong: null } };
    case "pick": {
      const v = s.hunt.phase;
      if (!v) return s;
      const line = render(huntShape(v))[a.line];
      if (!line) return s;
      const clicks = s.hunt.clicks + 1;
      if (line.buggy) {
        const res: HuntResult = { ms: Math.max(0, a.at - s.hunt.startedAt), clicks };
        return { ...s, hunt: { ...s.hunt, phase: null, clicks: 0, wrong: null, [v]: res } };
      }
      return { ...s, hunt: { ...s.hunt, clicks, wrong: a.line } };
    }
  }
}
