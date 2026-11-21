// Password storage playground: a leaked users table and an attacker with GPUs.
//
// After this, the reader can answer: once the table has leaked, what decides how many accounts
// fall and how fast? (The attacker's guesses per second, set by how slow your hash is, divided
// by the number of separate jobs, which the per-user salt sets. A salt makes every user a new
// job and makes precomputed tables useless; a slow, memory-hard hash makes every guess cost
// thousands of times more. Neither saves "123456".)
//
// The reader picks how the table was stored and the cost setting, the attacker's GPUs, how long
// the attacker keeps going, and whether the attacker has a precomputed lookup table. The model
// computes which sample users fall, the share of 100,000 users cracked, the time until half
// fall, and what the setting costs the login server. Plain state + pure functions, tested in Node.

export type Scheme = "plain" | "sha256" | "sha256salt" | "pbkdf2" | "bcrypt" | "scrypt" | "argon2id";
export const SCHEMES: Scheme[] = ["plain", "sha256", "sha256salt", "pbkdf2", "bcrypt", "scrypt", "argon2id"];

export const SCHEME_NAME: Record<Scheme, string> = {
  plain: "Plain text",
  sha256: "SHA-256",
  sha256salt: "SHA-256 + salt",
  pbkdf2: "PBKDF2",
  bcrypt: "bcrypt",
  scrypt: "scrypt",
  argon2id: "Argon2id",
};

/** Users in the leaked table. The sample rows are shown; the population is used for the counts. */
export const POPULATION = 100_000;

/** One RTX 4090, hashcat 6.2.6 (Chick3nman's public benchmark). */
export const BENCH = {
  sha256: 21_975.5e6, // mode 1400
  sha256salt: 21_960.3e6, // mode 1410, sha256($pass.$salt)
  pbkdf2At999: 8_865.7e3, // mode 10900, 999 iterations
  bcryptCost5: 184.0e3, // mode 3200, 32 iterations = cost 5
  scryptN14: 7_126, // mode 8900, N = 16384, r = 8, p = 1
};
/** hashcat 6.2.6 has no Argon2 mode, so Argon2id is estimated from memory bandwidth (attacker's best case). */
export const GPU_BANDWIDTH = 1.008e12; // bytes per second, RTX 4090

export interface CostLevel { label: string; note: string }
export interface Argon2Level { mKiB: number; t: number; p: number; label: string; note: string }

export const PBKDF2_ITERS = [10_000, 100_000, 600_000, 1_000_000];
export const BCRYPT_COSTS = [8, 10, 12, 14];
export const SCRYPT_LOGN = [14, 15, 16, 17];
export const ARGON2_LEVELS: Argon2Level[] = [
  { mKiB: 7 * 1024, t: 5, p: 1, label: "7 MiB · t=5", note: "OWASP minimum, low-memory end" },
  { mKiB: 19 * 1024, t: 2, p: 1, label: "19 MiB · t=2", note: "OWASP minimum, and the argon2 crate's default" },
  { mKiB: 64 * 1024, t: 3, p: 4, label: "64 MiB · t=3 · p=4", note: "RFC 9106 second recommendation; argon2-cffi's default" },
  { mKiB: 2 * 1024 * 1024, t: 1, p: 4, label: "2 GiB · t=1 · p=4", note: "RFC 9106 first recommendation" },
];

export const COST_LEVELS: Record<Scheme, string[]> = {
  plain: [],
  sha256: [],
  sha256salt: [],
  pbkdf2: PBKDF2_ITERS.map((i) => `${i.toLocaleString("en-US")} iterations`),
  bcrypt: BCRYPT_COSTS.map((c) => `cost ${c}`),
  scrypt: SCRYPT_LOGN.map((k) => `N=2^${k} · r=8 (${128 * 8 * 2 ** k / 2 ** 20} MiB)`),
  argon2id: ARGON2_LEVELS.map((l) => l.label),
};
/** The default cost index per scheme: the OWASP-recommended setting. */
export const DEFAULT_COST: Record<Scheme, number> = { plain: 0, sha256: 0, sha256salt: 0, pbkdf2: 2, bcrypt: 1, scrypt: 3, argon2id: 1 };

export const salted = (s: Scheme) => s !== "plain" && s !== "sha256";

/** Guesses per second on one GPU. */
export function guessRate(s: Scheme, cost: number): number {
  switch (s) {
    case "plain": return Infinity;
    case "sha256": return BENCH.sha256;
    case "sha256salt": return BENCH.sha256salt;
    case "pbkdf2": return (BENCH.pbkdf2At999 * 999) / PBKDF2_ITERS[cost];
    case "bcrypt": return BENCH.bcryptCost5 / 2 ** (BCRYPT_COSTS[cost] - 5);
    case "scrypt": return BENCH.scryptN14 / 2 ** (SCRYPT_LOGN[cost] - 14);
    case "argon2id": {
      // Each pass writes every 1 KiB block once and reads two: about 3 KiB of traffic per block per pass.
      const l = ARGON2_LEVELS[cost];
      return GPU_BANDWIDTH / (3 * l.mKiB * 1024 * l.t);
    }
  }
}

/** About how long one hash takes the login server, in ms (one core per lane). Ballpark figures. */
export function loginMs(s: Scheme, cost: number): number {
  switch (s) {
    case "plain": return 0;
    case "sha256":
    case "sha256salt": return 0.001;
    case "pbkdf2": return PBKDF2_ITERS[cost] / 4000;
    case "bcrypt": return 62.5 * 2 ** (BCRYPT_COSTS[cost] - 10);
    case "scrypt": return 40 * 2 ** (SCRYPT_LOGN[cost] - 14);
    case "argon2id": { const l = ARGON2_LEVELS[cost]; return (l.mKiB / 1024) * l.t * 0.8 / l.p; }
  }
}

/** Memory one hash needs, in MiB (what limits parallel guesses on a GPU). */
export function memoryMiB(s: Scheme, cost: number): number {
  if (s === "scrypt") return (128 * 8 * 2 ** SCRYPT_LOGN[cost]) / 2 ** 20;
  if (s === "argon2id") return ARGON2_LEVELS[cost].mKiB / 1024;
  if (s === "bcrypt") return 4 / 1024; // 4 KiB of S-boxes
  return 0;
}

/* ---------------- the password population ---------------- */

/**
 * Share of users whose password is found within the attacker's first r guesses (best guesses
 * first: leaked-password lists, then words with rules, then brute force). Illustrative, shaped
 * like studies of leaked password sets: a big head of common passwords and a long tail.
 */
export const CURVE: [number, number][] = [
  [1, 0.02], [1e1, 0.04], [1e3, 0.12], [1e6, 0.35], [1e9, 0.55], [1e12, 0.72], [1e15, 0.82], [1e18, 0.88], [1e30, 1],
];

export function crackedShare(guessesPerUser: number): number {
  if (guessesPerUser < 1) return 0;
  const x = Math.log10(guessesPerUser);
  for (let i = 1; i < CURVE.length; i++) {
    const [r0, f0] = CURVE[i - 1], [r1, f1] = CURVE[i];
    const x0 = Math.log10(r0), x1 = Math.log10(r1);
    if (x <= x1) return f0 + ((x - x0) / (x1 - x0)) * (f1 - f0);
  }
  return 1;
}

/** The guess rank at which a share f of users has fallen (inverse of crackedShare). */
export function rankForShare(f: number): number {
  if (f <= CURVE[0][1]) return 1;
  for (let i = 1; i < CURVE.length; i++) {
    const [r0, f0] = CURVE[i - 1], [r1, f1] = CURVE[i];
    if (f <= f1) return 10 ** (Math.log10(r0) + ((f - f0) / (f1 - f0)) * (Math.log10(r1) - Math.log10(r0)));
  }
  return 1e30;
}

export interface User { name: string; password: string; rank: number; why: string }

/** Sample rows. The rank is how many guesses into a good attack the password comes up. */
export const USERS: User[] = [
  { name: "ana", password: "123456", rank: 1, why: "the most common password in every leak" },
  { name: "ben", password: "password1", rank: 9, why: "top-ten list" },
  { name: "dev", password: "123456", rank: 1, why: "same as ana" },
  { name: "hal", password: "letmein", rank: 40, why: "top-hundred list" },
  { name: "chloe", password: "summer2024", rank: 3e4, why: "word + year" },
  { name: "jo", password: "Blink182!", rank: 2e7, why: "band name + symbol, in leak lists" },
  { name: "eli", password: "Tr0ub4dor&3", rank: 5e10, why: "word with substitutions: rules find it" },
  { name: "gus", password: "Qx7!mPz2", rank: 3.3e15, why: "8 random printable characters: on average half of 95^8" },
  { name: "fay", password: "maple-cinder-ocean-violin", rank: 1.8e15, why: "4 random words from a 7776-word list: on average half of 7776^4" },
  { name: "ivy", password: "k9#Vb2…(20 random)", rank: 1e39, why: "password manager, 20 random characters" },
];

/* ---------------- a real SHA-256, so the unsalted hashes are the real ones ---------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const len = ((msg.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(len);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const bits = msg.length * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(len - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(len - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64ish = (hex: string, n: number) => Array.from({ length: n }, (_, i) => B64[parseInt(hex.slice((i * 2) % 62, (i * 2) % 62 + 2), 16) % 64]).join("");

/** Each user's random salt (fixed per user so the view is stable). */
export const saltHex = (u: User) => sha256Hex("salt:" + u.name).slice(0, 32);

/** What the leaked row holds. SHA-256 values are real; the slow hashes show the real format with illustrative bytes. */
export function storedValue(s: Scheme, cost: number, u: User): string {
  const salt = saltHex(u);
  switch (s) {
    case "plain": return u.password;
    case "sha256": return sha256Hex(u.password);
    case "sha256salt": return `${salt.slice(0, 16)}:${sha256Hex(u.password + salt.slice(0, 16))}`;
    case "pbkdf2": return `$pbkdf2-sha256$i=${PBKDF2_ITERS[cost]}$${b64ish(salt, 22)}$${b64ish(sha256Hex(s + cost + salt + u.password), 43)}`;
    case "bcrypt": return `$2b$${String(BCRYPT_COSTS[cost]).padStart(2, "0")}$${b64ish(salt, 22)}${b64ish(sha256Hex(s + cost + salt + u.password), 31)}`;
    case "scrypt": return `$scrypt$ln=${SCRYPT_LOGN[cost]},r=8,p=1$${b64ish(salt, 22)}$${b64ish(sha256Hex(s + cost + salt + u.password), 43)}`;
    case "argon2id": { const l = ARGON2_LEVELS[cost]; return `$argon2id$v=19$m=${l.mKiB},t=${l.t},p=${l.p}$${b64ish(salt, 22)}$${b64ish(sha256Hex(s + cost + salt + u.password), 43)}`; }
  }
}

/* ---------------- the attack ---------------- */

export type Gpus = 1 | 8 | 1000;
export const GPUS: Gpus[] = [1, 8, 1000];
export const TIMES = [60, 3600, 86_400, 604_800, 2_592_000, 31_536_000];
export const TIME_NAME = ["1 minute", "1 hour", "1 day", "1 week", "1 month", "1 year"];
/** A lookup table of hashes of the most likely passwords, like CrackStation's 1.5 billion entries. */
export const TABLE_SIZE = 1.5e9;

export interface Setup { scheme: Scheme; cost: number; gpus: Gpus; time: number; tables: boolean }

/** Guesses the attacker tests per user after t seconds. Unsalted: one guess tests every user at once. */
export function guessesPerUser(s: Setup, t: number): number {
  if (s.scheme === "plain") return Infinity;
  const total = guessRate(s.scheme, s.cost) * s.gpus * t;
  return salted(s.scheme) ? total / POPULATION : total;
}

/** Precomputed tables work only when the same password always gives the same stored value. */
export const tablesWork = (s: Setup) => s.tables && s.scheme === "sha256";

export function shareAt(s: Setup, t: number): number {
  if (s.scheme === "plain") return 1;
  const f = crackedShare(guessesPerUser(s, t));
  return tablesWork(s) ? Math.max(f, crackedShare(TABLE_SIZE)) : f;
}

/** Seconds until user u falls (0 for plain text or a table hit). */
export function userFallsAt(s: Setup, u: User): number {
  if (s.scheme === "plain") return 0;
  if (tablesWork(s) && u.rank <= TABLE_SIZE) return 0;
  const rate = guessRate(s.scheme, s.cost) * s.gpus;
  return (u.rank * (salted(s.scheme) ? POPULATION : 1)) / rate;
}

/** Seconds until half the users have fallen. */
export function halfAt(s: Setup): number {
  if (s.scheme === "plain") return 0;
  if (tablesWork(s) && crackedShare(TABLE_SIZE) >= 0.5) return 0;
  const rate = guessRate(s.scheme, s.cost) * s.gpus;
  return (rankForShare(0.5) * (salted(s.scheme) ? POPULATION : 1)) / rate;
}

/** Stored values that appear more than once: equal passwords show up without cracking anything. */
export function duplicates(s: Setup): string[][] {
  const by = new Map<string, string[]>();
  for (const u of USERS) {
    const v = storedValue(s.scheme, s.cost, u);
    by.set(v, [...(by.get(v) ?? []), u.name]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

export interface Run extends Setup {
  n: number;
  cracked: number; // of POPULATION
  share: number;
  half: number; // seconds
  fallen: string[]; // sample users cracked within the time
  loginMs: number;
  memMiB: number;
}

export function attack(s: Setup, n: number): Run {
  const t = TIMES[s.time];
  const share = shareAt(s, t);
  return {
    ...s, n, share, cracked: Math.round(share * POPULATION), half: halfAt(s),
    fallen: USERS.filter((u) => userFallsAt(s, u) <= t).map((u) => u.name),
    loginMs: loginMs(s.scheme, s.cost), memMiB: memoryMiB(s.scheme, s.cost),
  };
}

/** Cores the login service needs for a peak of `perSecond` logins at this setting. */
export const coresFor = (ms: number, perSecond = 200) => Math.max(1, Math.ceil((perSecond * ms) / 1000));

/* ---------------- state ---------------- */

export interface State extends Setup {
  runs: Run[];
  /** The stored value the reader clicked, to find equal rows. */
  picked: string | null;
  spottedDuplicate: boolean;
}

export type Action =
  | { type: "scheme"; scheme: Scheme }
  | { type: "cost"; cost: number }
  | { type: "gpus"; gpus: Gpus }
  | { type: "time"; time: number }
  | { type: "tables" }
  | { type: "pick"; value: string | null }
  | { type: "attack" }
  | { type: "reset" };

export function init(): State {
  return { scheme: "sha256salt", cost: 0, gpus: 1, time: 2, tables: false, runs: [], picked: null, spottedDuplicate: false };
}

export const setupOf = (s: State): Setup => ({ scheme: s.scheme, cost: s.cost, gpus: s.gpus, time: s.time, tables: s.tables });

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "scheme": return { ...st, scheme: a.scheme, cost: DEFAULT_COST[a.scheme], picked: null };
    case "cost": return { ...st, cost: Math.max(0, Math.min(a.cost, Math.max(0, COST_LEVELS[st.scheme].length - 1))) };
    case "gpus": return { ...st, gpus: a.gpus };
    case "time": return { ...st, time: Math.max(0, Math.min(a.time, TIMES.length - 1)) };
    case "tables": return { ...st, tables: !st.tables };
    case "pick": {
      if (a.value === null || a.value === st.picked) return { ...st, picked: null };
      const same = USERS.filter((u) => storedValue(st.scheme, st.cost, u) === a.value).length;
      return { ...st, picked: a.value, spottedDuplicate: st.spottedDuplicate || (same > 1 && st.scheme !== "plain") };
    }
    case "attack": {
      const n = (st.runs[st.runs.length - 1]?.n ?? 0) + 1;
      return { ...st, runs: [...st.runs, attack(setupOf(st), n)].slice(-12) };
    }
  }
}

/* ---------------- challenges ---------------- */

export interface Goals { tableInstant: boolean; duplicates: boolean; survivesYear: boolean; tooCostly: boolean }
export function goals(st: State): Goals {
  return {
    tableInstant: st.runs.some((r) => r.scheme === "sha256" && r.tables && r.time === 0 && r.share >= 0.5),
    duplicates: st.spottedDuplicate,
    survivesYear: st.runs.some((r) => r.gpus === 1000 && r.time === 5 && r.share < 0.5),
    tooCostly: st.runs.some((r) => r.loginMs >= 1000 || r.memMiB >= 1024),
  };
}

/* ---------------- formatting ---------------- */

export function fmtDuration(sec: number): string {
  if (!isFinite(sec)) return "never";
  if (sec <= 0) return "instantly";
  if (sec < 1) return "under a second";
  const units: [number, string][] = [[31_536_000, "year"], [86_400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  if (sec >= 31_536_000 * 1000) {
    const y = sec / 31_536_000;
    return `${y >= 1e6 ? y.toExponential(0).replace("e+", "×10^") : Math.round(y).toLocaleString("en-US")} years`;
  }
  for (const [u, name] of units) if (sec >= u) { const v = Math.round(sec / u); return `${v.toLocaleString("en-US")} ${name}${v === 1 ? "" : "s"}`; }
  return "instantly";
}

export function fmtRate(r: number): string {
  if (!isFinite(r)) return "no work needed";
  const u: [number, string][] = [[1e9, "G"], [1e6, "M"], [1e3, "k"]];
  for (const [d, p] of u) if (r >= d) return `${(r / d).toFixed(r / d >= 100 ? 0 : 1)} ${p} guesses/s`;
  return `${r.toFixed(r >= 100 ? 0 : 1)} guesses/s`;
}
