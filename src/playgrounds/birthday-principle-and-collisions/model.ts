// Birthday playground: random IDs for uploaded files, and the chance that two of them match.
//
// After this, the reader can answer: "For n random IDs drawn from d possible values, when do
// collisions start, and how many bits does an ID need for my n?"
// Core insight: collisions are about pairs, and n IDs make about n²/2 pairs. The chance that
// some pair matches is about 1 - e^(-n²/2d), so collisions become likely near √d IDs, not near d.
// A 32-bit ID (4.3 billion values) is more likely than not to collide by about 77,000 IDs, and a
// 2-million-file import expects about 466 colliding pairs. Every extra bit doubles d, so each
// doubling of n costs two bits. 122 or 128 random bits make the chance negligible for any real n;
// an insert-if-absent check makes the rare collision harmless.
//
// Pure and deterministic: a seeded PRNG drives the simulations, so tests can replay them.

export const MIN_BITS = 8;
export const MAX_BITS = 128;
/** Simulations draw uniform integers below d with 53-bit doubles, so d must be at most 2^53. */
export const SIM_MAX_BITS = 52;
/** The first-collision experiment draws about 1.25·√d IDs per trial; keep it fast. */
export const TRIAL_MAX_BITS = 32;
export const TRIALS_PER_RUN = 10;
export const IMPORT_MAX = 2_000_000;
export const IMPORT_N = 2_000_000;

export interface Preset { id: string; label: string; bits: number; note: string }
export const PRESETS: Preset[] = [
  { id: "hex8", label: "8 hex chars", bits: 32, note: "4 random bytes, hex encoded" },
  { id: "b62x6", label: "6 base62 chars", bits: 6 * Math.log2(62), note: "a short link code, 62^6 values" },
  { id: "u64", label: "64-bit random", bits: 64, note: "a random int64 primary key" },
  { id: "uuid4", label: "UUIDv4", bits: 122, note: "122 random bits; 6 bits are fixed" },
  { id: "b128", label: "16 random bytes", bits: 128, note: "secrets.token_hex(16)" },
];

/** ln(n(n-1)/2) - bits·ln 2: the log of the expected number of colliding pairs. */
const logPairs = (n: number, bits: number) => (n < 2 ? -Infinity : Math.log(n) + Math.log(n - 1) - Math.LN2 - bits * Math.LN2);

/** Expected number of pairs that share an ID: C(n, 2) / d. */
export const expectedPairs = (n: number, bits: number) => Math.exp(logPairs(n, bits));

/** P(at least one collision) ≈ 1 - e^(-n(n-1)/2d). expm1 keeps tiny probabilities exact. */
export const pCollide = (n: number, bits: number) => -Math.expm1(-expectedPairs(n, bits));

/** The exact probability: 1 - Π (1 - i/d) for i < n. Only for small d. */
export function pExact(n: number, bits: number): number {
  const d = 2 ** bits;
  if (n > d) return 1;
  let logNone = 0;
  for (let i = 1; i < n; i++) logNone += Math.log1p(-i / d);
  return -Math.expm1(logNone);
}

/** IDs needed for a given collision probability: √(2d·ln(1/(1-p))). */
export const nFor = (p: number, bits: number) => Math.sqrt(2 * 2 ** bits * -Math.log1p(-p));
/** The 50% point, about 1.18·√d. */
export const n50 = (bits: number) => nFor(0.5, bits);
/** Expected IDs drawn until the first repeat: about √(πd/2), about 1.25·√d. */
export const meanFirst = (bits: number) => Math.sqrt((Math.PI * 2 ** bits) / 2);
/** Fewest whole bits that keep n IDs at or under probability p: n²/2d ≤ -ln(1-p). */
export const bitsNeeded = (n: number, p: number) => Math.ceil(Math.log2((n * (n - 1)) / 2 / -Math.log1p(-p)));

/* ---------------- seeded randomness ---------------- */

/**
 * sfc32 (Small Fast Counter), a 128-bit-state generator, expanded from one 32-bit seed. A small
 * generator whose 32-bit outputs repeat more often than chance (mulberry32 does) would fake the
 * very collisions this playground measures, so the state is wider than the output.
 */
export function rng(seed: number) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 15; i++) next();
  return {
    next32: next,
    /** A uniform integer below 2^bits (bits ≤ 52, may be fractional), from 53 random bits. */
    id: (bits: number) => Math.floor(((next() * 2 ** 21 + (next() >>> 11)) / 2 ** 53) * 2 ** bits),
  };
}

/** An open-addressing set of non-negative integers below 2^53: much faster than Set for millions of IDs. */
export function idSet(capacityHint: number) {
  let cap = 1024;
  while (cap < capacityHint * 2) cap *= 2;
  const slots = new Float64Array(cap); // id + 1; 0 marks an empty slot
  let size = 0;
  return {
    get size() { return size; },
    /** Adds id; returns false if it was already present. */
    add(id: number): boolean {
      const v = id + 1;
      let i = Math.imul((v % 4294967296) ^ Math.floor(v / 4294967296), 0x9e3779b1) >>> 0;
      for (;;) {
        i &= cap - 1;
        const x = slots[i];
        if (x === 0) { slots[i] = v; size++; return true; }
        if (x === v) return false;
        i++;
      }
    },
  };
}

/** Draw IDs until one repeats. Returns how many were drawn (including the repeat) and a new seed. */
export function firstCollision(seed: number, bits: number): [number, number] {
  const g = rng(seed);
  const seen = idSet(Math.min(2 ** bits, 4 * meanFirst(bits)));
  for (;;) if (!seen.add(g.id(bits))) return [seen.size + 1, g.next32()];
}

export type Mode = "overwrite" | "retry";
export interface ImportRun { n: number; bits: number; mode: Mode; collisions: number; lost: number; retries: number; expected: number }
/** Save n files under random IDs. Overwrite: a repeat replaces a file. Retry: a repeat draws again. */
export function runImport(seed: number, n: number, bits: number, mode: Mode): [ImportRun, number] {
  const g = rng(seed);
  const seen = idSet(n);
  let collisions = 0, retries = 0;
  for (let i = 0; i < n; i++) {
    if (seen.add(g.id(bits))) continue;
    collisions++;
    if (mode === "retry") do retries++; while (!seen.add(g.id(bits)));
  }
  return [{ n, bits, mode, collisions, lost: mode === "overwrite" ? collisions : 0, retries, expected: expectedPairs(n, bits) }, g.next32()];
}

/* ---------------- the playground state ---------------- */

export const CHALLENGES = [
  { id: "under100k", text: "Make a collision more likely than not with fewer than 100,000 IDs." },
  { id: "import", text: "Import 2 million files with 32-bit names and count the overwrites." },
  { id: "safeImport", text: "Import them again and lose nothing." },
  { id: "billion", text: "Find the fewest bits that keep 1 billion IDs under a one-in-a-billion chance." },
  { id: "agree", text: "Run 20+ first-collision trials and land the average within 10% of 1.25·√d." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  bits: number;
  n: number;
  trials: number[]; // first-collision counts at the current bits
  seed: number;
  mode: Mode;
  imported: ImportRun | null;
  prediction: string | null;
  ranSim: boolean; // ran a simulation at least once (reveals the prediction)
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "bits"; bits: number }
  | { type: "preset"; id: string }
  | { type: "n"; n: number }
  | { type: "trials" }
  | { type: "mode"; mode: Mode }
  | { type: "import" }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    bits: 32, n: 10_000, trials: [], seed: 0x5eed1234, mode: "overwrite", imported: null, prediction: null, ranSim: false,
    done: { under100k: false, import: false, safeImport: false, billion: false, agree: false },
  };
}

export const trialMean = (s: State) => (s.trials.length ? s.trials.reduce((a, b) => a + b, 0) / s.trials.length : 0);
export const canTrial = (bits: number) => bits <= TRIAL_MAX_BITS;
export const canImport = (n: number, bits: number) => n <= IMPORT_MAX && bits <= SIM_MAX_BITS;

function score(s: State): State {
  const d = { ...s.done };
  if (s.n < 100_000 && pCollide(s.n, s.bits) >= 0.5) d.under100k = true;
  if (s.imported && s.imported.n === IMPORT_N && Math.round(s.imported.bits) === 32 && s.imported.lost > 0) d.import = true;
  if (d.import && s.imported && s.imported.n === IMPORT_N && s.imported.lost === 0) d.safeImport = true;
  if (s.n === 1_000_000_000 && s.bits === bitsNeeded(1e9, 1e-9) && pCollide(s.n, s.bits) <= 1e-9) d.billion = true;
  if (s.trials.length >= 20 && Math.abs(trialMean(s) / meanFirst(s.bits) - 1) <= 0.1) d.agree = true;
  return { ...s, done: d };
}

const clampN = (n: number) => Math.max(2, Math.min(1e15, Math.round(n)));

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "bits": {
      const bits = Math.max(MIN_BITS, Math.min(MAX_BITS, Math.round(a.bits)));
      return bits === s.bits ? s : score({ ...s, bits, trials: [] });
    }
    case "preset": {
      const p = PRESETS.find((x) => x.id === a.id);
      return p ? score({ ...s, bits: p.bits, trials: [] }) : s;
    }
    case "n":
      return Number.isFinite(a.n) ? score({ ...s, n: clampN(a.n) }) : s;
    case "trials": {
      if (!canTrial(s.bits)) return s;
      let seed = s.seed, c: number;
      const trials = [...s.trials];
      for (let i = 0; i < TRIALS_PER_RUN; i++) { [c, seed] = firstCollision(seed, s.bits); trials.push(c); }
      return score({ ...s, trials, seed, ranSim: true });
    }
    case "mode":
      return { ...s, mode: a.mode };
    case "import": {
      const n = s.n;
      if (!canImport(n, s.bits)) return s;
      const [run, seed] = runImport(s.seed, n, s.bits, s.mode);
      return score({ ...s, imported: run, seed, ranSim: true });
    }
  }
}
