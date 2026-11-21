// Floating-point ledger: one stream of money amounts summed three ways, plus a bit inspector.
//
// After this, the reader can answer: why does a float64 total of ten $0.10 charges come out as
// 0.9999999999999999, why does a float32 balance of $300,000 ignore a one-cent deposit, and why
// does a total kept in integer cents never drift?
//
// The ledger adds the same amount, again and again, to three running totals: a float64, a
// float32 and an integer count of cents (the exact answer). Every float add rounds to the
// nearest representable value, exactly as IEEE 754 does with round-to-nearest-even. float32
// arithmetic is emulated with Math.fround on a double result, which is correctly rounded for
// + - * / because a double has more than twice float32's precision.
// The inspector shows the bits of any value (sign, exponent, mantissa), the exact decimal value
// those bits store, and the gap to the next representable number. Reader-controlled: toggle any
// bit, type a value or a two-operand sum, or click a ledger total to inspect it.
// Break-it: start from a large balance, where the gap between floats is wider than a cent.
// Plain state + a pure step function, so it can be tested without a browser.

export type Width = 32 | 64;
export type StartKey = "zero" | "k1" | "k300" | "t20";
export type AmountKey = "c10" | "c1" | "c20" | "c1999";
export type Col = "f64" | "f32";
export type Prediction = "exact" | "tiny" | "cent";
export type ChallengeId = "notEqual" | "ignored" | "cent64" | "wideGap";

export const STARTS: { value: StartKey; label: string; cents: bigint; note: string }[] = [
  { value: "zero", label: "$0", cents: 0n, note: "a fresh invoice" },
  { value: "k1", label: "$1,000", cents: 100_000n, note: "a small account" },
  { value: "k300", label: "$300,000", cents: 30_000_000n, note: "a merchant's monthly balance" },
  { value: "t20", label: "$20 trillion", cents: 2_000_000_000_000_000n, note: "a year of volume on a large card network" },
];
export const AMOUNTS: { value: AmountKey; label: string; cents: bigint }[] = [
  { value: "c10", label: "$0.10", cents: 10n },
  { value: "c1", label: "$0.01", cents: 1n },
  { value: "c20", label: "$0.20", cents: 20n },
  { value: "c1999", label: "$19.99", cents: 1999n },
];
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "notEqual", text: "Make the float64 total differ from the exact total." },
  { id: "ignored", text: "Make a float32 add change nothing at all." },
  { id: "cent64", text: "Make float64 drift by a whole cent or more." },
  { id: "wideGap", text: "Inspect a value whose gap to the next float is wider than a cent." },
];
export const MAX_ADDS = 2_000_000;

export interface Totals { f64: number; f32: number; cents: bigint }
export interface Batch { n: number; adds: number; amount: AmountKey; d64: number; d32: number }
export interface Inspect { width: Width; bits: bigint; source: string; error: string | null }

export interface State {
  start: StartKey;
  amount: AmountKey;
  adds: number;
  totals: Totals;
  /** The totals just before the most recent single add, to recover that deposit by subtraction. */
  prev: Totals | null;
  /** Did the most recent add leave the float32 total unchanged? */
  lastIgnored32: boolean;
  batches: Batch[];
  insp: Inspect;
  prediction: Prediction | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "start"; value: StartKey }
  | { type: "amount"; value: AmountKey }
  | { type: "add"; n: number }
  | { type: "inspectTotal"; col: Col }
  | { type: "toggleBit"; i: number }
  | { type: "width"; value: Width }
  | { type: "enter"; text: string }
  | { type: "predict"; value: Prediction }
  | { type: "reset" };

/* ---------------------------------------------------------------- bits and values */

export const LAYOUT = {
  32: { exp: 8, frac: 23, bias: 127 },
  64: { exp: 11, frac: 52, bias: 1023 },
} as const;

export function bitsOf(x: number, width: Width): bigint {
  const dv = new DataView(new ArrayBuffer(8));
  if (width === 64) { dv.setFloat64(0, x); return dv.getBigUint64(0); }
  dv.setFloat32(0, x);
  return BigInt(dv.getUint32(0));
}

export function valueOf(bits: bigint, width: Width): number {
  const dv = new DataView(new ArrayBuffer(8));
  if (width === 64) { dv.setBigUint64(0, BigInt.asUintN(64, bits)); return dv.getFloat64(0); }
  dv.setUint32(0, Number(BigInt.asUintN(32, bits)));
  return dv.getFloat32(0);
}

/** Round a double to the nearest value of the given width. */
export const round = (x: number, width: Width) => (width === 32 ? Math.fround(x) : x);

export type Kind = "zero" | "subnormal" | "normal" | "infinity" | "nan";
export interface Fields { sign: number; exp: number; frac: bigint; kind: Kind; unbiased: number }

export function fields(bits: bigint, width: Width): Fields {
  const L = LAYOUT[width];
  const fracMask = (1n << BigInt(L.frac)) - 1n;
  const expMask = (1n << BigInt(L.exp)) - 1n;
  const frac = bits & fracMask;
  const exp = Number((bits >> BigInt(L.frac)) & expMask);
  const sign = Number((bits >> BigInt(L.frac + L.exp)) & 1n);
  const maxExp = Number(expMask);
  let kind: Kind;
  if (exp === 0) kind = frac === 0n ? "zero" : "subnormal";
  else if (exp === maxExp) kind = frac === 0n ? "infinity" : "nan";
  else kind = "normal";
  const unbiased = exp === 0 ? 1 - L.bias : exp - L.bias;
  return { sign, exp, frac, kind, unbiased };
}

/** The value as an exact integer times a power of two: x = m * 2^e. Finite values only. */
export function rational(x: number): { m: bigint; e: number } {
  const f = fields(bitsOf(x, 64), 64);
  const sig = f.exp === 0 ? f.frac : f.frac | (1n << 52n);
  const e = (f.exp === 0 ? 1 : f.exp) - 1075;
  return { m: f.sign ? -sig : sig, e };
}

/** Every digit of the value the bits really hold. Floats are dyadic fractions, so this ends. */
export function exactDecimal(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const { m, e } = rational(x);
  const neg = m < 0n;
  const a = neg ? -m : m;
  let out: string;
  if (e >= 0) out = (a << BigInt(e)).toString();
  else {
    const k = -e;
    const digits = (a * 5n ** BigInt(k)).toString().padStart(k + 1, "0");
    const int = digits.slice(0, digits.length - k);
    const frac = digits.slice(digits.length - k).replace(/0+$/, "");
    out = frac ? `${int}.${frac}` : int;
  }
  return (neg ? "-" : "") + out;
}

/** The shortest decimal that reads back to the same value at this width (what print shows). */
export function shortest(x: number, width: Width): string {
  if (!Number.isFinite(x)) return String(x);
  if (width === 64) return String(x);
  for (let p = 1; p <= 9; p++) {
    const s = x.toPrecision(p);
    if (Math.fround(Number(s)) === x) return String(Number(s));
  }
  return String(x);
}

/** Distance from |x| to the next representable value away from zero. */
export function gap(x: number, width: Width): number {
  if (!Number.isFinite(x)) return NaN;
  const a = Math.abs(round(x, width));
  const up = valueOf(bitsOf(a, width) + 1n, width);
  return up - a;
}

/** (x - cents/100) in cents, computed exactly from the bits and rounded only at the end. */
export function driftCents(x: number, cents: bigint): number {
  if (!Number.isFinite(x)) return NaN;
  const { m, e } = rational(x);
  if (e >= 0) return Number((m * 100n << BigInt(e)) - cents);
  let k = -e;
  let num = m * 100n - (cents << BigInt(k));
  if (k > 900) { num >>= BigInt(k - 900); k = 900; }
  return Number(num) / 2 ** k;
}

/** Parse "0.1", "1e16", "nan", "-inf", or "a + b" (also - * /), computed at the given width. */
export function evaluate(text: string, width: Width): { value: number } | { error: string } {
  const num = String.raw`([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[+-]?inf(?:inity)?|nan|2\^\d+)`;
  const m = new RegExp(String.raw`^\s*${num}\s*(?:([+\-*/])\s*${num})?\s*$`, "i").exec(text);
  if (!m) return { error: "Type a number such as 0.1, or a sum such as 0.1 + 0.2." };
  const parse = (s: string) => {
    const t = s.toLowerCase();
    if (t === "nan") return NaN;
    if (t.includes("inf")) return t.startsWith("-") ? -Infinity : Infinity;
    if (t.startsWith("2^")) return 2 ** Number(t.slice(2));
    return Number(t);
  };
  const a = round(parse(m[1]), width);
  if (!m[2]) return { value: a };
  const b = round(parse(m[3]), width);
  const r = m[2] === "+" ? a + b : m[2] === "-" ? a - b : m[2] === "*" ? a * b : a / b;
  return { value: round(r, width) };
}

/* ---------------------------------------------------------------- the ledger */

export const startOf = (k: StartKey) => STARTS.find((s) => s.value === k)!;
export const amountOf = (k: AmountKey) => AMOUNTS.find((a) => a.value === k)!;
/** The amount as a float of the given width: the nearest value to the decimal. */
export const amountFloat = (k: AmountKey, width: Width) => round(Number(amountOf(k).cents) / 100, width);

function opening(k: StartKey): Totals {
  const d = Number(startOf(k).cents) / 100;
  return { f64: d, f32: Math.fround(d), cents: startOf(k).cents };
}

const inspectOf = (x: number, width: Width, source: string): Inspect => ({ width, bits: bitsOf(round(x, width), width), source, error: null });

const noneDone = (): Record<ChallengeId, boolean> => ({ notEqual: false, ignored: false, cent64: false, wideGap: false });

export function init(): State {
  return {
    start: "zero", amount: "c10", adds: 0, totals: opening("zero"), prev: null, lastIgnored32: false, batches: [],
    insp: inspectOf(0.1, 64, "0.1"), prediction: null, done: noneDone(),
  };
}

/** Add the amount n times to each total. */
export function addMany(t: Totals, amount: AmountKey, n: number): { totals: Totals; prev: Totals | null; ignored32: boolean; anyIgnored32: boolean } {
  const a64 = amountFloat(amount, 64);
  const a32 = amountFloat(amount, 32);
  const c = amountOf(amount).cents;
  let f64 = t.f64, f32 = t.f32, prev: Totals | null = null, ignored32 = false, anyIgnored32 = false;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) prev = { f64, f32, cents: t.cents + c * BigInt(n - 1) };
    f64 = f64 + a64;
    const next32 = Math.fround(f32 + a32);
    ignored32 = next32 === f32;
    if (ignored32) anyIgnored32 = true;
    f32 = next32;
  }
  return { totals: { f64, f32, cents: t.cents + c * BigInt(n) }, prev, ignored32, anyIgnored32 };
}

export const drift = (st: State, col: Col) => driftCents(st.totals[col], st.totals.cents);
/** The exact total as the nearest double: what `total == expected` compares against. */
export const expected = (st: State, width: Width) => round(Number(st.totals.cents) / 100, width);
export const equal = (st: State, col: Col) => st.totals[col] === expected(st, col === "f64" ? 64 : 32);

/** The last deposit, recovered by subtracting the totals before and after it. */
export function recovered(st: State, col: Col): number | null {
  if (!st.prev) return null;
  return st.totals[col] - st.prev[col];
}

export function formatCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${s}.${(a % 100n).toString().padStart(2, "0")}`;
}

function mark(st: State): State {
  const done = { ...st.done };
  if (st.adds > 0 && !equal(st, "f64")) done.notEqual = true;
  if (Math.abs(drift(st, "f64")) >= 1) done.cent64 = true;
  const x = valueOf(st.insp.bits, st.insp.width);
  if (Number.isFinite(x) && gap(x, st.insp.width) > 0.01) done.wideGap = true;
  return { ...st, done };
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "start":
      return mark({ ...st, start: a.value, adds: 0, totals: opening(a.value), prev: null, lastIgnored32: false, batches: [] });
    case "amount":
      return { ...st, amount: a.value };
    case "add": {
      const n = Math.max(0, Math.min(a.n, MAX_ADDS - st.adds));
      if (n === 0) return st;
      const r = addMany(st.totals, st.amount, n);
      const next: State = { ...st, adds: st.adds + n, totals: r.totals, prev: r.prev, lastIgnored32: r.ignored32 };
      const batch: Batch = { n, adds: next.adds, amount: st.amount, d64: drift(next, "f64"), d32: drift(next, "f32") };
      const done = r.anyIgnored32 ? { ...st.done, ignored: true } : st.done;
      return mark({ ...next, batches: [batch, ...st.batches].slice(0, 6), done });
    }
    case "inspectTotal": {
      const w: Width = a.col === "f64" ? 64 : 32;
      return mark({ ...st, insp: inspectOf(st.totals[a.col], w, `${a.col === "f64" ? "float64" : "float32"} total`) });
    }
    case "toggleBit": {
      const bits = st.insp.bits ^ (1n << BigInt(a.i));
      return mark({ ...st, insp: { ...st.insp, bits, source: "your bits", error: null } });
    }
    case "width": {
      const x = valueOf(st.insp.bits, st.insp.width);
      return mark({ ...st, insp: inspectOf(x, a.value, st.insp.source) });
    }
    case "enter": {
      const r = evaluate(a.text, st.insp.width);
      if ("error" in r) return { ...st, insp: { ...st.insp, error: r.error } };
      return mark({ ...st, insp: inspectOf(r.value, st.insp.width, a.text.trim()) });
    }
    case "predict":
      return { ...st, prediction: a.value };
    case "reset":
      return init();
  }
}
