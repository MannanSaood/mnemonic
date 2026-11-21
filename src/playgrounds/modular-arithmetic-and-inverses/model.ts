// Modular arithmetic playground: a clock of m ticks, the extended Euclidean algorithm that finds
// inverses on it, and a toy RSA key built from both.
//
// After this, the reader can answer: "When can you divide by a modulo m, how do you find the
// inverse, and why does RSA decryption undo encryption?"
// Core insight: multiplying by a on an m-tick clock is reversible exactly when gcd(a, m) = 1.
// Seen on the dial, the multiples of a then visit every tick and land on 1; that landing is the
// inverse. When a shares a factor with m, the multiples visit only m / gcd ticks and never reach
// 1, so different inputs collide and nothing can undo the multiply. The extended Euclidean
// algorithm finds the inverse in a few steps by keeping r = s·a (mod m) on every row. RSA is the
// same idea one level up: d is the inverse of e modulo φ(n), so raising to e and then to d returns
// the message. A toy key falls to brute force at once; real RSA needs 2048-bit moduli and padding.
//
// Pure and deterministic. Every RSA number here stays below 2^53, so plain numbers are exact as
// long as each product is reduced; the "naive" path shows what happens when it is not.

export const MODULI = [8, 10, 12, 13, 16, 26] as const;
export type Modulus = (typeof MODULI)[number];
export const PRIMES = [5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61] as const;
export const EXPONENTS = [3, 5, 7, 11, 13, 17] as const;

export function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Python-style remainder: always in [0, m). JavaScript's % keeps the sign of the dividend. */
export const mod = (x: number, m: number) => ((x % m) + m) % m;

/** The multiples a, 2a, 3a, ... mod m until they come back to 0. Length m / gcd(a, m). */
export function orbit(a: number, m: number): number[] {
  const out: number[] = [];
  let x = 0;
  do { x = (x + a) % m; out.push(x); } while (x !== 0 && out.length <= m);
  return out;
}

export interface EuclidRow { r: number; s: number; q: number | null }
/**
 * Extended Euclid on (m, a). Each row keeps r ≡ s·a (mod m). Rows stop when r reaches 0; the row
 * before it holds gcd(a, m), and if that is 1 its s is the inverse of a.
 */
export function euclid(a: number, m: number): EuclidRow[] {
  const rows: EuclidRow[] = [{ r: m, s: 0, q: null }, { r: mod(a, m), s: 1, q: null }];
  while (rows[rows.length - 1].r !== 0) {
    const [p, c] = [rows[rows.length - 2], rows[rows.length - 1]];
    const q = Math.floor(p.r / c.r);
    rows.push({ r: p.r - q * c.r, s: p.s - q * c.s, q });
  }
  return rows;
}

export function inverse(a: number, m: number): number | null {
  const rows = euclid(a, m);
  const g = rows[rows.length - 2];
  return g.r === 1 ? mod(g.s, m) : null;
}

export const invariantHolds = (row: EuclidRow, a: number, m: number) => mod(row.r, m) === mod(row.s * a, m);

export interface PowStep { bit: 0 | 1; squared: number; result: number }
/** Square-and-multiply, most significant bit first, reducing mod n after every product. */
export function powTrace(b: number, e: number, n: number): PowStep[] {
  const steps: PowStep[] = [];
  let x = 1;
  for (const ch of e.toString(2)) {
    const squared = (x * x) % n;
    x = ch === "1" ? (squared * b) % n : squared;
    steps.push({ bit: ch === "1" ? 1 : 0, squared, result: x });
  }
  return steps;
}
export const modPow = (b: number, e: number, n: number) => powTrace(b, e, n).at(-1)!.result;
/** The same power computed as m ** e first and reduced once: doubles lose the low digits. */
export const naivePow = (b: number, e: number, n: number) => (b ** e) % n;

export interface Key { p: number; q: number; n: number; phi: number; e: number; d: number | null }
export function key(p: number, q: number, e: number): Key {
  const n = p * q, phi = (p - 1) * (q - 1);
  return { p, q, n, phi, e, d: p === q ? null : inverse(e, phi) };
}

/** An attacker with only (n, e) and c: encrypt every candidate until one matches. Returns tries. */
export function bruteForce(c: number, k: Key): { msg: number; tries: number } {
  for (let x = 0; x < k.n; x++) if (modPow(x, k.e, k.n) === c) return { msg: x, tries: x + 1 };
  return { msg: -1, tries: k.n };
}
/** Factor n by trial division. Returns the smaller prime and how many divisions it took. */
export function factor(n: number): { p: number; divisions: number } {
  let divisions = 0;
  for (let f = 2; f * f <= n; f++) { divisions++; if (n % f === 0) return { p: f, divisions }; }
  return { p: n, divisions };
}

export interface Sent { msg: number; c: number }
export const CHALLENGES = [
  { id: "skip", text: "Find a step size that never lands on some ticks." },
  { id: "inv7", text: "Find the inverse of 7 on a 26-tick clock." },
  { id: "noKey", text: "Pick an e that has no private key." },
  { id: "roundTrip", text: "Encrypt a message and decrypt it back." },
  { id: "crack", text: "Read a message without the private key." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  m: Modulus;
  a: number;
  rowsShown: number; // how many Euclid rows are visible (at least 2)
  prediction: string | null;
  sawEight: boolean; // looked at 8 on the 12-tick clock
  p: number;
  q: number;
  e: number;
  msg: number;
  sent: Sent[];
  decrypted: number | null;
  attack: { msg: number; tries: number; divisions: number } | null;
  naive: boolean;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "m"; m: Modulus }
  | { type: "a"; a: number }
  | { type: "euclidStep" }
  | { type: "euclidAll" }
  | { type: "p"; p: number }
  | { type: "q"; q: number }
  | { type: "e"; e: number }
  | { type: "msg"; msg: number }
  | { type: "encrypt" }
  | { type: "decrypt" }
  | { type: "attack" }
  | { type: "naive" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    m: 12, a: 5, rowsShown: 2, prediction: null, sawEight: false,
    p: 61, q: 53, e: 17, msg: 65, sent: [], decrypted: null, attack: null, naive: false,
    done: { skip: false, inv7: false, noKey: false, roundTrip: false, crack: false },
  };
}

export const currentKey = (s: State) => key(s.p, s.q, s.e);
export const euclidDone = (s: State) => s.rowsShown >= euclid(s.a, s.m).length;

function score(s: State): State {
  const d = { ...s.done };
  if (gcd(s.a, s.m) > 1 && s.a % s.m !== 0) d.skip = true;
  if (s.m === 26 && s.a === 7 && euclidDone(s)) d.inv7 = true;
  const k = currentKey(s);
  if (k.d === null && k.p !== k.q) d.noKey = true;
  if (s.decrypted !== null && s.sent.length && s.decrypted === s.sent[s.sent.length - 1].msg && !s.naive) d.roundTrip = true;
  if (s.attack) d.crack = true;
  return { ...s, sawEight: s.sawEight || (s.m === 12 && s.a === 8), done: d };
}

/** Changing the key invalidates everything encrypted with the old one. */
const rekey = (s: State, patch: Partial<State>): State => score({ ...s, ...patch, sent: [], decrypted: null, attack: null, msg: Math.min(s.msg, key(patch.p ?? s.p, patch.q ?? s.q, patch.e ?? s.e).n - 1) });

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "m":
      return score({ ...s, m: a.m, a: Math.min(s.a, a.m - 1), rowsShown: 2 });
    case "a":
      return a.a < 1 || a.a >= s.m ? s : score({ ...s, a: a.a, rowsShown: 2 });
    case "euclidStep":
      return score({ ...s, rowsShown: Math.min(s.rowsShown + 1, euclid(s.a, s.m).length) });
    case "euclidAll":
      return score({ ...s, rowsShown: euclid(s.a, s.m).length });
    case "p":
      return rekey(s, { p: a.p });
    case "q":
      return rekey(s, { q: a.q });
    case "e":
      return rekey(s, { e: a.e });
    case "msg": {
      const n = currentKey(s).n;
      const msg = Math.max(0, Math.min(n - 1, Math.floor(a.msg)));
      return Number.isFinite(msg) ? { ...s, msg, decrypted: null } : s;
    }
    case "encrypt": {
      const k = currentKey(s);
      const c = s.naive ? naivePow(s.msg, k.e, k.n) : modPow(s.msg, k.e, k.n);
      return score({ ...s, sent: [...s.sent, { msg: s.msg, c }].slice(-6), decrypted: null, attack: null });
    }
    case "decrypt": {
      const k = currentKey(s);
      const last = s.sent[s.sent.length - 1];
      if (!last || k.d === null) return s;
      const back = s.naive ? naivePow(last.c, k.d, k.n) : modPow(last.c, k.d, k.n);
      return score({ ...s, decrypted: back });
    }
    case "attack": {
      const k = currentKey(s);
      const last = s.sent[s.sent.length - 1];
      if (!last || !Number.isInteger(last.c)) return s;
      const b = bruteForce(last.c, k);
      return score({ ...s, attack: { ...b, divisions: factor(k.n).divisions } });
    }
    case "naive":
      return score({ ...s, naive: !s.naive, sent: [], decrypted: null, attack: null });
  }
}
