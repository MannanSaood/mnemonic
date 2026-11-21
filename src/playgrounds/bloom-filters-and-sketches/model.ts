// Bloom filter playground: a crawler's "have we crawled this URL?" check, with a slow crawl
// database behind a small bit array.
//
// After this, the reader can answer: "How many bits per item and how many hash functions does a
// Bloom filter need for a given false-positive rate, and why can't it delete?"
// Core insight: a Bloom filter never says "no" to an item it holds, so a "no" can skip the slow
// store outright; a "maybe" is wrong at a rate fixed by bits per item (m/n) and the number of
// hashes k, about (1 - e^(-kn/m))^k. Too few hashes leave too little evidence, too many fill the
// array; the best k is about (m/n) ln 2, and about 10 bits per item buys about 1%. Clearing an
// item's bits to delete it clears bits other items share, and they start returning "no": false
// negatives, the one error the structure promised never to make.
//
// Pure and deterministic: URLs come from fixed generators and a seeded PRNG drives the crawl.

export const M_OPTIONS = [128, 256, 512, 1024] as const;
export type Bits = (typeof M_OPTIONS)[number];
export const K_MAX = 8;
export const LINKS_PER_PAGE = 20;
export const MAX_URLS = 400;
export const PROBES = 2000;
export const STORE_MS = 2;
/** Rough bytes per URL in an in-memory hash set: the string, its header and the table slot. */
export const SET_BYTES_PER_URL = 100;

/** 32-bit FNV-1a with a seed, then the murmur3 finaliser. */
export function fnv(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The k bit positions for an item: double hashing, h1 + i*h2 (Kirsch and Mitzenmacher). */
export function positions(url: string, m: number, k: number): number[] {
  const h1 = fnv(url, 0x811c9dc5);
  const h2 = (fnv(url, 0x27d4eb2f) | 1) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push((h1 + i * h2) % m); // exact: stays below 2^53
  return out;
}

const HOSTS = ["shop.example.com/products", "docs.example.org/guide", "news.example.net/2026", "blog.example.io/posts", "help.example.com/articles"];
/** URLs the crawler discovers, in discovery order. */
export const urlFor = (i: number) => `https://${HOSTS[i % HOSTS.length]}/${(i * 7919 + 13) % 100000}`;
/** URLs the crawler has never seen: the probe set for measuring false positives. */
export const probeUrl = (i: number) => `https://cdn.example.dev/assets/${i}-${(i * 2654435761) >>> 0}`;

export function emptyBits(m: number): number[] {
  return Array(m).fill(0);
}
export function addTo(bits: number[], url: string, k: number): number[] {
  const b = bits.slice();
  for (const p of positions(url, b.length, k)) b[p] = 1;
  return b;
}
export function test(bits: number[], url: string, k: number): boolean {
  return positions(url, bits.length, k).every((p) => bits[p] === 1);
}
export function buildBits(urls: string[], m: number, k: number): number[] {
  const b = emptyBits(m);
  for (const u of urls) for (const p of positions(u, m, k)) b[p] = 1;
  return b;
}

/** The textbook false-positive rate for n items, m bits, k hashes. */
export const formula = (n: number, m: number, k: number) => (n === 0 ? 0 : (1 - Math.exp((-k * n) / m)) ** k);
/** The k that minimises the formula: (m/n) ln 2. */
export const bestK = (n: number, m: number) => (n === 0 ? K_MAX : Math.max(1, Math.min(K_MAX, Math.round((m / n) * Math.LN2))));

/** Measured false-positive rate: the share of never-crawled URLs the filter says "maybe" to. */
export function measured(bits: number[], k: number): number {
  let fp = 0;
  for (let i = 0; i < PROBES; i++) if (test(bits, probeUrl(i), k)) fp++;
  return fp / PROBES;
}

/** Measured rate for every k from 1 to K_MAX, on a filter rebuilt from the same URLs. */
export function curve(urls: string[], m: number): { k: number; measured: number; formula: number }[] {
  return Array.from({ length: K_MAX }, (_, i) => {
    const k = i + 1;
    return { k, measured: measured(buildBits(urls, m, k), k), formula: formula(urls.length, m, k) };
  });
}

export const fill = (bits: number[]) => bits.reduce((a, b) => a + b, 0) / bits.length;

export type Verdict = "new" | "seen" | "falsePositive" | "falseNegative" | "probeNo" | "probeFp" | "removed";
export interface Last { url: string; positions: number[]; verdict: Verdict }

export const CHALLENGES = [
  { id: "flood", text: "Push the measured false-positive rate above 20%." },
  { id: "tight", text: "Hold 100+ URLs at 10 bits per URL or less with false positives under 2%." },
  { id: "bestK", text: "With 64+ URLs in 512 bits, pick the k with the lowest measured rate." },
  { id: "falseNeg", text: "Make a crawled URL look new: get the filter to say no to something it holds." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export interface State {
  m: Bits;
  k: number;
  bits: number[];
  crawled: string[];
  nextNew: number;
  nextProbe: number;
  rng: number;
  links: number;
  skipped: number;
  storeLookups: number;
  falsePositives: number;
  recrawls: number;
  removed: number;
  last: Last | null;
  kTried: number[];
  prediction: string | null;
  done: Record<ChallengeId, boolean>;
}

export type Action =
  | { type: "crawl"; pages: number }
  | { type: "probe" }
  | { type: "m"; m: Bits }
  | { type: "k"; k: number }
  | { type: "remove"; url: string }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    m: 256, k: 3, bits: emptyBits(256), crawled: [], nextNew: 0, nextProbe: 0, rng: 0x2545f491,
    links: 0, skipped: 0, storeLookups: 0, falsePositives: 0, recrawls: 0, removed: 0,
    last: null, kTried: [3], prediction: null,
    done: { flood: false, tight: false, bestK: false, falseNeg: false },
  };
}

/** mulberry32: a tiny seeded PRNG, returned with its next state. */
function rand(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** Crawled URLs the filter now answers "no" for. */
export const falseNegatives = (s: State) => s.crawled.filter((u) => !test(s.bits, u, s.k));

/** One discovered link: about half point at pages already crawled, half at new ones. */
function link(s: State): State {
  let r: number, rng = s.rng;
  [r, rng] = rand(rng);
  let url: string, truth: boolean;
  if (s.crawled.length && r < 0.5) {
    let r2: number;
    [r2, rng] = rand(rng);
    url = s.crawled[Math.floor(r2 * s.crawled.length)];
    truth = true;
  } else {
    if (s.crawled.length >= MAX_URLS) return { ...s, rng };
    url = urlFor(s.nextNew);
    truth = false;
  }
  const pos = positions(url, s.m, s.k);
  const maybe = pos.every((p) => s.bits[p] === 1);
  const base = { ...s, rng, links: s.links + 1, nextNew: truth ? s.nextNew : s.nextNew + 1 };
  if (maybe) {
    // Ask the crawl database. A seen URL is skipped; a false positive still gets crawled.
    if (truth) return { ...base, storeLookups: base.storeLookups + 1, last: { url, positions: pos, verdict: "seen" } };
    return {
      ...base, storeLookups: base.storeLookups + 1, falsePositives: base.falsePositives + 1,
      crawled: [...base.crawled, url], last: { url, positions: pos, verdict: "falsePositive" },
    };
  }
  // "No" skips the database. Right for new URLs; for a crawled one, it means crawling it again.
  const bits = addTo(s.bits, url, s.k);
  if (truth) return { ...base, bits, skipped: base.skipped + 1, recrawls: base.recrawls + 1, last: { url, positions: pos, verdict: "falseNegative" } };
  return { ...base, bits, skipped: base.skipped + 1, crawled: [...base.crawled, url], last: { url, positions: pos, verdict: "new" } };
}

function score(s: State): State {
  const d = { ...s.done };
  const n = s.crawled.length;
  const fp = n ? measured(s.bits, s.k) : 0;
  if (fp > 0.2) d.flood = true;
  if (n >= 100 && s.m / n <= 10 && fp < 0.02) d.tight = true;
  if (s.m === 512 && n >= 64) {
    const c = curve(s.crawled, s.m);
    const min = Math.min(...c.map((x) => x.measured));
    if (c[s.k - 1].measured === min) d.bestK = true;
  }
  if (falseNegatives(s).length > 0 || s.recrawls > 0) d.falseNeg = true;
  return { ...s, done: d };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "crawl": {
      let n = s;
      for (let i = 0; i < a.pages * LINKS_PER_PAGE; i++) n = link(n);
      return score(n);
    }
    case "probe": {
      const url = probeUrl(PROBES + s.nextProbe); // outside the measuring set
      const pos = positions(url, s.m, s.k);
      const maybe = pos.every((p) => s.bits[p] === 1);
      return { ...s, nextProbe: s.nextProbe + 1, last: { url, positions: pos, verdict: maybe ? "probeFp" : "probeNo" } };
    }
    case "m":
      return a.m === s.m ? s : score({ ...s, m: a.m, bits: buildBits(s.crawled, a.m, s.k), last: null });
    case "k": {
      if (a.k === s.k || a.k < 1 || a.k > K_MAX) return s;
      const kTried = s.kTried.includes(a.k) ? s.kTried : [...s.kTried, a.k];
      return score({ ...s, k: a.k, kTried, bits: buildBits(s.crawled, s.m, a.k), last: null });
    }
    case "remove": {
      if (!s.crawled.includes(a.url)) return s;
      // The tempting delete: clear the URL's bits. Other URLs that share any of them now test "no".
      const pos = positions(a.url, s.m, s.k);
      const bits = s.bits.slice();
      for (const p of pos) bits[p] = 0;
      return score({ ...s, bits, crawled: s.crawled.filter((u) => u !== a.url), removed: s.removed + 1, last: { url: a.url, positions: pos, verdict: "removed" } });
    }
  }
}
