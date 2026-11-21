// Purpose: after this, the reader can answer: "Why does A & B, which asks for more properties,
// accept fewer values than A or B, and what does 'A is assignable to B' mean in pictures?"
//
// A Venn view over a small universe of real values an HTTP client sees: method strings, status
// codes, null, undefined and request objects. The reader picks two types A and B and an operator
// (| or &). Every value lands in the region it belongs to; the result region is shaded. Clicking a
// value explains, per type, why it is in or out. The assignability line reads straight off the
// picture: A is assignable to B exactly when the "A only" region is empty.
//
// The universe is a sample: string and number hold infinitely many values. Every type here is
// defined so that the sample contains a witness for each relation the lesson states (the tests
// check the ones the prose relies on).
//
// Plain state + a pure step function, so it can be tested without a browser.

export type ValueId =
  | "get" | "put" | "delete" | "post" | "patch" | "lowerGet"
  | "s200" | "s503"
  | "null" | "undef"
  | "reqGet" | "reqPost" | "reqPut" | "health" | "cfgDelete" | "cfgPost";

export interface Value {
  id: ValueId;
  /** short label drawn inside the Venn */
  short: string;
  /** the value as JavaScript source */
  js: string;
  kind: "string" | "number" | "null" | "undefined" | "object";
  str?: string;
  num?: number;
  obj?: { method?: string; url?: string; body?: string; retries?: number };
}

export const VALUES: Value[] = [
  { id: "get", short: '"GET"', js: '"GET"', kind: "string", str: "GET" },
  { id: "put", short: '"PUT"', js: '"PUT"', kind: "string", str: "PUT" },
  { id: "delete", short: '"DELETE"', js: '"DELETE"', kind: "string", str: "DELETE" },
  { id: "post", short: '"POST"', js: '"POST"', kind: "string", str: "POST" },
  { id: "patch", short: '"PATCH"', js: '"PATCH"', kind: "string", str: "PATCH" },
  { id: "lowerGet", short: '"get"', js: '"get"', kind: "string", str: "get" },
  { id: "s200", short: "200", js: "200", kind: "number", num: 200 },
  { id: "s503", short: "503", js: "503", kind: "number", num: 503 },
  { id: "null", short: "null", js: "null", kind: "null" },
  { id: "undef", short: "undefined", js: "undefined", kind: "undefined" },
  { id: "reqGet", short: "{GET /invoices}", js: '{ method: "GET", url: "/v1/invoices" }', kind: "object", obj: { method: "GET", url: "/v1/invoices" } },
  { id: "reqPost", short: "{POST /charges}", js: '{ method: "POST", url: "/v1/charges", body: "{…}" }', kind: "object", obj: { method: "POST", url: "/v1/charges", body: "{…}" } },
  { id: "reqPut", short: "{PUT /invoices/42}", js: '{ method: "PUT", url: "/v1/invoices/42", body: "{…}" }', kind: "object", obj: { method: "PUT", url: "/v1/invoices/42", body: "{…}" } },
  { id: "health", short: "{url /healthz}", js: '{ url: "/healthz" }', kind: "object", obj: { url: "/healthz" } },
  { id: "cfgDelete", short: "{DELETE retries:3}", js: '{ method: "DELETE", retries: 3 }', kind: "object", obj: { method: "DELETE", retries: 3 } },
  { id: "cfgPost", short: "{POST retries:0}", js: '{ method: "POST", retries: 0 }', kind: "object", obj: { method: "POST", retries: 0 } },
];
export const VALUE = Object.fromEntries(VALUES.map((v) => [v.id, v])) as Record<ValueId, Value>;

export type TypeId =
  | "unknown" | "never" | "string" | "number" | "null"
  | "method" | "idempotent" | "post" | "status5xx"
  | "hasUrl" | "hasMethod" | "retrySafe" | "postOnly";

const IDEMPOTENT = ["GET", "HEAD", "PUT", "DELETE"];
const METHOD = [...IDEMPOTENT, "POST", "PATCH"];
const isObj = (v: Value) => v.kind === "object";

export interface TypeDef {
  id: TypeId;
  /** the name a reader would write */
  name: string;
  /** what the name stands for, in TypeScript */
  def: string;
  /** properties a value of this type is guaranteed to have (object types only) */
  keys: string[];
  object: boolean;
  /** membership, with a one-line reason either way */
  test: (v: Value) => { in: boolean; why: string };
}

const yes = (why: string) => ({ in: true, why });
const no = (why: string) => ({ in: false, why });

export const TYPES: TypeDef[] = [
  { id: "unknown", name: "unknown", def: "every value", keys: [], object: false, test: () => yes("unknown contains every value") },
  { id: "never", name: "never", def: "no value at all", keys: [], object: false, test: () => no("never contains no value") },
  { id: "string", name: "string", def: "every string", keys: [], object: false,
    test: (v) => (v.kind === "string" ? yes("it is a string") : no(`it is ${article(v.kind)}, not a string`)) },
  { id: "number", name: "number", def: "every number", keys: [], object: false,
    test: (v) => (v.kind === "number" ? yes("it is a number") : no(`it is ${article(v.kind)}, not a number`)) },
  { id: "null", name: "null", def: "the one value null", keys: [], object: false,
    test: (v) => (v.kind === "null" ? yes("it is null") : no("only null itself is in null")) },
  { id: "method", name: "Method", def: '"GET" | "HEAD" | "PUT" | "DELETE" | "POST" | "PATCH"', keys: [], object: false,
    test: (v) => (v.kind !== "string" ? no("Method holds six strings and nothing else") : METHOD.includes(v.str!) ? yes(`"${v.str}" is one of the six methods`) : no(`"${v.str}" is not one of the six methods; case matters`)) },
  { id: "idempotent", name: "Idempotent", def: '"GET" | "HEAD" | "PUT" | "DELETE"', keys: [], object: false,
    test: (v) => (v.kind !== "string" ? no("Idempotent holds four strings and nothing else") : IDEMPOTENT.includes(v.str!) ? yes(`"${v.str}" is safe to retry`) : no(`"${v.str}" is not in the four retry-safe methods`)) },
  { id: "post", name: '"POST"', def: 'a literal type: the one string "POST"', keys: [], object: false,
    test: (v) => (v.kind === "string" && v.str === "POST" ? yes('it is exactly "POST"') : no('only the string "POST" is in "POST"')) },
  { id: "status5xx", name: "Status5xx", def: "500 | 502 | 503 | 504", keys: [], object: false,
    test: (v) => (v.kind === "number" && [500, 502, 503, 504].includes(v.num!) ? yes(`${v.num} is a retryable server error`) : no(v.kind === "number" ? `${v.num} is not one of the four` : "Status5xx holds four numbers")) },
  { id: "hasUrl", name: "{ url: string }", def: "every object with a string url, whatever else it has", keys: ["url"], object: true,
    test: (v) => (!isObj(v) ? no("not an object") : typeof v.obj!.url === "string" ? yes("it has url: string; extra properties are allowed") : no("it has no url")) },
  { id: "hasMethod", name: "{ method: Method }", def: "every object whose method is one of the six", keys: ["method"], object: true,
    test: (v) => (!isObj(v) ? no("not an object") : v.obj!.method === undefined ? no("it has no method") : METHOD.includes(v.obj!.method) ? yes(`method "${v.obj!.method}" is a Method`) : no(`method "${v.obj!.method}" is not a Method`)) },
  { id: "retrySafe", name: "{ method: Idempotent }", def: "every object whose method is safe to retry", keys: ["method"], object: true,
    test: (v) => (!isObj(v) ? no("not an object") : v.obj!.method === undefined ? no("it has no method") : IDEMPOTENT.includes(v.obj!.method) ? yes(`method "${v.obj!.method}" is Idempotent`) : no(`method "${v.obj!.method}" is not Idempotent`)) },
  { id: "postOnly", name: '{ method: "POST" }', def: 'every object whose method is exactly "POST"', keys: ["method"], object: true,
    test: (v) => (!isObj(v) ? no("not an object") : v.obj!.method === "POST" ? yes('method is "POST"') : no(v.obj!.method ? `method is "${v.obj!.method}", not "POST"` : "it has no method")) },
];
export const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t])) as Record<TypeId, TypeDef>;

function article(kind: Value["kind"]) {
  return kind === "object" ? "an object" : kind === "undefined" ? "undefined" : kind === "null" ? "null" : `a ${kind}`;
}

export type Op = "|" | "&";

/** Members of a type, in universe order. */
export const members = (t: TypeId) => VALUES.filter((v) => TYPE[t].test(v).in).map((v) => v.id);

export type Region = "aOnly" | "both" | "bOnly" | "neither";
export function regionOf(a: TypeId, b: TypeId, v: ValueId): Region {
  const ia = TYPE[a].test(VALUE[v]).in, ib = TYPE[b].test(VALUE[v]).in;
  return ia && ib ? "both" : ia ? "aOnly" : ib ? "bOnly" : "neither";
}

export function resultMembers(a: TypeId, b: TypeId, op: Op): ValueId[] {
  return VALUES.filter((v) => {
    const r = regionOf(a, b, v.id);
    return op === "&" ? r === "both" : r !== "neither";
  }).map((v) => v.id);
}

/** A is assignable to B when every value of A is also in B. Returns a counterexample if not. */
export function assignable(a: TypeId, b: TypeId): { ok: boolean; witness: ValueId | null } {
  const w = VALUES.find((v) => regionOf(a, b, v.id) === "aOnly");
  return { ok: !w, witness: w ? w.id : null };
}

/**
 * Properties you may read on a value of the result type without checking first.
 * Only defined when both sides are object types (null when it does not apply).
 * A & B guarantees every key of either; A | B guarantees only the keys both share.
 */
export function readableKeys(a: TypeId, b: TypeId, op: Op): string[] | null {
  const A = TYPE[a], B = TYPE[b];
  if (!A.object || !B.object) return null;
  if (op === "&") return [...new Set([...A.keys, ...B.keys])];
  return A.keys.filter((k) => B.keys.includes(k));
}

/** What the result is the same set as, when it is (over this universe) one of the operands or empty. */
export function sameAs(a: TypeId, b: TypeId, op: Op): "never" | "a" | "b" | null {
  const r = resultMembers(a, b, op);
  if (r.length === 0) return "never";
  const eq = (t: TypeId) => { const m = members(t); return m.length === r.length && m.every((x) => r.includes(x)); };
  if (eq(a)) return "a";
  if (eq(b)) return "b";
  return null;
}

/* ---------------- state ---------------- */

export type Predict = "more" | "fewer" | "same";
export const PREDICT_ANSWER: Predict = "fewer";

export type ChallengeId = "shrink" | "never" | "subset" | "absorb";

export interface State {
  a: TypeId;
  b: TypeId;
  op: Op;
  selected: ValueId | null;
  predict: Predict | null;
  /** the reader has looked at an intersection of two different object types */
  revealed: boolean;
  done: ChallengeId[];
}

export type Action =
  | { type: "setA"; t: TypeId }
  | { type: "setB"; t: TypeId }
  | { type: "op"; op: Op }
  | { type: "swap" }
  | { type: "select"; v: ValueId | null }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { a: "hasMethod", b: "hasUrl", op: "|", selected: null, predict: null, revealed: false, done: [] };
}

export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "shrink", text: "Build an A & B that asks for more properties than A or B, yet fits fewer values than either." },
  { id: "never", text: "Find two types, neither of them never, whose intersection is empty." },
  { id: "subset", text: "Find an A that is assignable to a different B: the A-only region is empty." },
  { id: "absorb", text: "Find an A | B that is the same set as B alone, with A not never." },
];

/** Which challenges the current picture satisfies. */
export function satisfied(s: Pick<State, "a" | "b" | "op">): ChallengeId[] {
  const { a, b, op } = s;
  const out: ChallengeId[] = [];
  const r = resultMembers(a, b, op).length;
  const keys = readableKeys(a, b, op);
  if (op === "&" && keys && keys.length > Math.max(TYPE[a].keys.length, TYPE[b].keys.length)
    && r > 0 && r < Math.min(members(a).length, members(b).length)) out.push("shrink");
  if (op === "&" && a !== "never" && b !== "never" && r === 0) out.push("never");
  if (a !== b && members(a).length > 0 && assignable(a, b).ok) out.push("subset");
  if (op === "|" && a !== b && members(a).length > 0 && sameAs(a, b, op) === "b") out.push("absorb");
  return out;
}

function record(s: State): State {
  const add = satisfied(s).filter((c) => !s.done.includes(c));
  const revealed = s.revealed || (s.op === "&" && TYPE[s.a].object && TYPE[s.b].object && s.a !== s.b);
  return add.length || revealed !== s.revealed ? { ...s, done: [...s.done, ...add], revealed } : s;
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "setA": return record({ ...s, a: a.t });
    case "setB": return record({ ...s, b: a.t });
    case "op": return record({ ...s, op: a.op });
    case "swap": return record({ ...s, a: s.b, b: s.a });
    case "select": return { ...s, selected: s.selected === a.v ? null : a.v };
    case "predict": return s.revealed ? s : { ...s, predict: a.value };
  }
}

/** One line on why a value is or is not in the result. */
export function explain(s: Pick<State, "a" | "b" | "op">, v: ValueId): { inResult: boolean; a: string; b: string; verdict: string } {
  const ta = TYPE[s.a].test(VALUE[v]), tb = TYPE[s.b].test(VALUE[v]);
  const inResult = s.op === "&" ? ta.in && tb.in : ta.in || tb.in;
  let verdict: string;
  if (s.op === "&") verdict = inResult ? "It is in both, so it is in A & B." : `A & B needs both, and it fails ${!ta.in && !tb.in ? "both" : !ta.in ? "A" : "B"}.`;
  else verdict = inResult ? `A | B needs either one, and it is in ${ta.in && tb.in ? "both" : ta.in ? "A" : "B"}.` : "It is in neither, so not even A | B accepts it.";
  return { inResult, a: ta.why, b: tb.why, verdict };
}
