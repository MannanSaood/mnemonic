// Caching playground: one hot key (a product's price) in front of a database, for 40 seconds.
//
// After this, the reader can answer: "How does a cache in front of a database go stale or
// overload it, and which choice prevents each failure?"
// Core insight: a TTL bounds staleness but makes every expiry a miss, and without coalescing a
// hot key's expiry sends every concurrent reader to the database at once (the thundering herd).
// Deleting on write keeps the cache fresh, except when a write lands while a refill is in
// flight: the refill read the old row before the write and stores it after the delete, so the
// cache serves the old price for a whole TTL. Leases (a fill is refused once the key was
// invalidated after the fill started) close that race; single-flight loads or early refresh
// stop the herd.
//
// Deterministic fluid model in 100 ms ticks. Pure; every run is kept for comparison.

export const TICK_MS = 100;
export const SECONDS = 40;
export const TICKS = (SECONDS * 1000) / TICK_MS;
export const READS_PER_S = 200;
const READS_PER_TICK = READS_PER_S / (1000 / TICK_MS);
/** A database read of the row takes this long (the load window). */
export const LOAD_TICKS = 3;
/** Queries per second the database handles comfortably. */
export const DB_CAPACITY = 50;
export const WRITE1_S = 8;
export const WRITE2_S = 21;
/** With the race switched on, the second write waits for the first refill in flight after this time. */
export const RACE_AFTER_S = 18;
export const PRICES = [120, 105, 99];

export type Pattern = "aside" | "through" | "write-through";
export const PATTERNS: Pattern[] = ["aside", "through", "write-through"];
export const PATTERN_NAME: Record<Pattern, string> = { aside: "Cache-aside", through: "Read-through", "write-through": "Write-through" };
export const PATTERN_JOB: Record<Pattern, string> = {
  aside: "the app checks the cache, loads from the database on a miss, and fills the cache",
  through: "the cache library loads on a miss; concurrent misses for one key share one load",
  "write-through": "read-through, and every write updates the cache as well as the database",
};
export type Invalidate = "ttl" | "delete";
export const TTLS = [2, 5, 15] as const;
export type Ttl = (typeof TTLS)[number];

export interface Config {
  pattern: Pattern;
  ttl: Ttl;
  /** On write (cache-aside and read-through): only wait for the TTL, or delete the key. */
  invalidate: Invalidate;
  /** Cache-aside only: share one database load among concurrent misses (single-flight). */
  coalesce: boolean;
  /** Refresh the entry in the background shortly before it expires. */
  early: boolean;
  /** A fill is refused if the key was invalidated or written after the fill began. */
  lease: boolean;
  /** Break it: make the second write land while a refill is in flight. */
  race: boolean;
}

export const coalesces = (c: Config) => c.pattern !== "aside" || c.coalesce;

export interface Second { t: number; hits: number; misses: number; queries: number; stale: number; staleCache: boolean }

export interface LogEvent { id: number; t: number; ok: boolean; text: string; path: string[] }

export interface Summary {
  reads: number;
  hits: number;
  queries: number;
  peakQueries: number;
  peakAt: number;
  stale: number;
  /** Longest stretch, in seconds, during which the cache held a different price than the database. */
  longestStale: number;
  /** A fill that stored a value older than the database's. */
  raced: boolean;
  /** Fills refused by a lease. */
  refused: number;
}

export interface Run { id: number; config: Config; seconds: Second[]; summary: Summary; log: LogEvent[] }

interface Entry { price: number; version: number; expires: number }
interface Load { start: number; done: number; price: number; version: number; waiting: number; refresh: boolean }

/** Run 40 simulated seconds. Pure and deterministic. */
export function simulate(c: Config): { seconds: Second[]; summary: Summary; log: LogEvent[] } {
  const ttlTicks = c.ttl * (1000 / TICK_MS);
  const db = { price: PRICES[0], version: 0 };
  let cache: Entry | null = { price: db.price, version: 0, expires: ttlTicks }; // warm at the start
  let loads: Load[] = [];
  /** Tick of the last delete or write-through set; fills that began before it are refused under a lease. */
  let lastInvalidation = -1;
  let write1Done = false, write2Done = false;
  const seconds: Second[] = [];
  const log: LogEvent[] = [];
  let cur: Second = { t: 0, hits: 0, misses: 0, queries: 0, stale: 0, staleCache: false };
  let raced = false, refused = 0, staleRun = 0, longestStale = 0, herdLogs = 0;
  const at = (tick: number) => `${(tick / 10).toFixed(1)} s`;
  const note = (tick: number, ok: boolean, text: string, path: string[]) => log.push({ id: log.length + 1, t: tick, ok, text, path });

  function write(tick: number) {
    const v = db.version + 1;
    db.price = PRICES[v % PRICES.length];
    db.version = v;
    if (c.pattern === "write-through") {
      cache = { price: db.price, version: v, expires: tick + ttlTicks };
      lastInvalidation = tick;
      note(tick, true, `${at(tick)}: price set to ${db.price} in the database and in the cache.`, ["writer", `DB = ${db.price}`, `cache = ${db.price}`]);
    } else if (c.invalidate === "delete") {
      cache = null;
      lastInvalidation = tick;
      note(tick, true, `${at(tick)}: price set to ${db.price} in the database, key deleted from the cache.`, ["writer", `DB = ${db.price}`, "cache: delete"]);
    } else {
      note(tick, false, `${at(tick)}: price set to ${db.price} in the database. The cache keeps ${cache ? cache.price : "nothing"} until its TTL runs out.`, ["writer", `DB = ${db.price}`, "cache untouched"]);
    }
  }

  for (let tick = 0; tick < TICKS; tick++) {
    // Writes.
    // Writes land while the cache is warm and no refill is in flight, unless the race is switched on:
    // then the second write waits for a refill that read the row before it.
    if (!write1Done && tick >= WRITE1_S * 10 && loads.length === 0) { write(tick); write1Done = true; }
    if (write1Done && !write2Done) {
      const due = c.race
        ? tick >= RACE_AFTER_S * 10 && loads.some((l) => l.start < tick)
        : tick >= WRITE2_S * 10 && loads.length === 0;
      if (due) { write(tick); write2Done = true; }
    }

    // Finished loads fill the cache (the last one to finish wins) and serve their waiting readers.
    const finished = loads.filter((l) => l.done === tick);
    loads = loads.filter((l) => l.done !== tick);
    for (const l of finished) {
      const stale = l.version !== db.version;
      if (c.lease && l.start <= lastInvalidation && lastInvalidation >= 0 && stale) {
        refused++;
        note(tick, true, `${at(tick)}: a fill of price ${l.price} was refused. Its lease was revoked when the key was invalidated at ${at(lastInvalidation)}.`, ["loader", `fill ${l.price}`, "lease revoked", "refused"]);
      } else {
        if (stale && !raced) {
          raced = true;
          note(tick, false, `${at(tick)}: a refill that read price ${l.price} at ${at(l.start)}, before the write, stored it now, after the ${c.pattern === "write-through" ? "write-through set" : c.invalidate === "delete" ? "delete" : "write"}. The cache will serve ${l.price} until ${at(tick + ttlTicks)}.`, ["reader", `DB read ${l.price}`, "writer: DB + invalidate", `cache = ${l.price}`]);
        }
        cache = { price: l.price, version: l.version, expires: tick + ttlTicks };
      }
      // Readers who waited for this load get its price. They asked before any write it missed,
      // so they are not counted as stale reads; stale reads are hits on an outdated entry.
      cur.misses += l.waiting;
    }

    // Reads.
    let n = READS_PER_TICK;
    const live = cache && cache.expires > tick ? cache : null;
    if (live) {
      cur.hits += n;
      if (live.version !== db.version) cur.stale += n;
      n = 0;
      if (c.early && live.expires - tick <= LOAD_TICKS + 1 && !loads.some((l) => l.refresh)) {
        loads.push({ start: tick, done: tick + LOAD_TICKS, price: db.price, version: db.version, waiting: 0, refresh: true });
        cur.queries += 1;
      }
    } else {
      if (cache && cache.expires <= tick) cache = null;
      const inflight = loads[0];
      if (coalesces(c)) {
        if (inflight) inflight.waiting += n;
        else { loads.push({ start: tick, done: tick + LOAD_TICKS, price: db.price, version: db.version, waiting: n, refresh: false }); cur.queries += 1; }
      } else {
        // Every reader that misses goes to the database itself.
        loads.push({ start: tick, done: tick + LOAD_TICKS, price: db.price, version: db.version, waiting: n, refresh: false });
        cur.queries += n;
        if (tick > 0 && herdLogs < 2 && !loads.some((l) => l.start < tick)) {
          herdLogs++;
          note(tick, false, `${at(tick)}: the entry expired. Every reader in the next ${LOAD_TICKS * TICK_MS} ms misses and queries the database: ${READS_PER_TICK * LOAD_TICKS} queries for one row.`, ["cache: expired", `${READS_PER_TICK * LOAD_TICKS} readers`, "DB"]);
        }
      }
    }

    // Staleness of the stored entry.
    const stored = cache && cache.expires > tick ? cache : null;
    const disagree = !!stored && stored.version !== db.version;
    if (disagree) { staleRun++; cur.staleCache = true; } else staleRun = 0;
    longestStale = Math.max(longestStale, staleRun);

    if ((tick + 1) % 10 === 0) {
      seconds.push(cur);
      cur = { t: seconds.length, hits: 0, misses: 0, queries: 0, stale: 0, staleCache: false };
    }
  }

  const sum = (f: (s: Second) => number) => Math.round(seconds.reduce((a, s) => a + f(s), 0));
  const peak = seconds.reduce((b, s) => (s.queries > b.queries ? s : b), seconds[0]);
  return {
    seconds, log,
    summary: {
      reads: SECONDS * READS_PER_S,
      hits: sum((s) => s.hits),
      queries: sum((s) => s.queries),
      peakQueries: peak.queries,
      peakAt: peak.t,
      stale: sum((s) => s.stale),
      longestStale: longestStale / 10,
      raced,
      refused,
    },
  };
}

/* ---------------- the reader's state ---------------- */

export const CHALLENGES = [
  { id: "herd", text: "Make one expiry send 50 or more queries to the database within a second." },
  { id: "calm", text: "With a 2 s TTL, keep the database at 2 queries per second or fewer." },
  { id: "stuck", text: "With delete on write, make the cache serve an old price for more than 10 seconds." },
  { id: "fresh", text: "Keep the race switched on and finish with zero stale reads." },
] as const;
export type ChallengeId = (typeof CHALLENGES)[number]["id"];

export function challengeMet(r: Run, id: ChallengeId): boolean {
  const m = r.summary, c = r.config;
  switch (id) {
    case "herd": return m.peakQueries >= 50;
    case "calm": return c.ttl === 2 && m.peakQueries <= 2;
    case "stuck": return c.pattern !== "write-through" && c.invalidate === "delete" && m.longestStale > 10;
    case "fresh": return c.race && m.stale === 0;
  }
}

export interface State { config: Config; runs: Run[]; shown: number | null; seq: number; prediction: string | null }

export type Action =
  | { type: "set"; patch: Partial<Config> }
  | { type: "run" }
  | { type: "show"; id: number }
  | { type: "predict"; value: string }
  | { type: "reset" };

export function init(): State {
  return {
    config: { pattern: "aside", ttl: 5, invalidate: "ttl", coalesce: false, early: false, lease: false, race: false },
    runs: [], shown: null, seq: 1, prediction: null,
  };
}

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "predict":
      return s.prediction ? s : { ...s, prediction: a.value };
    case "set":
      return { ...s, config: { ...s.config, ...a.patch } };
    case "run": {
      const r = simulate(s.config);
      const run: Run = { id: s.seq, config: { ...s.config }, ...r };
      return { ...s, runs: [run, ...s.runs].slice(0, 6), shown: run.id, seq: s.seq + 1 };
    }
    case "show":
      return s.runs.some((r) => r.id === a.id) ? { ...s, shown: a.id } : s;
  }
}

export const shownRun = (s: State) => s.runs.find((r) => r.id === s.shown) ?? null;
export const challengeDone = (s: State, id: ChallengeId) => s.runs.some((r) => challengeMet(r, id));

export function describe(c: Config): string {
  const parts = [PATTERN_NAME[c.pattern], `TTL ${c.ttl} s`];
  if (c.pattern !== "write-through") parts.push(c.invalidate === "delete" ? "delete on write" : "TTL only");
  if (c.pattern === "aside" && c.coalesce) parts.push("single-flight");
  if (c.early) parts.push("early refresh");
  if (c.lease) parts.push("leases");
  if (c.race) parts.push("write during refill");
  return parts.join(", ");
}
