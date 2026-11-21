// DNS playground: one recursive resolver, the root, two TLDs and two zones' name servers.
//
// After this, the reader can answer: what happens between getaddrinfo() and an IP address, why
// is the second lookup nearly free, and why does a changed record take up to its TTL to reach
// you? (The resolver walks root, TLD, authoritative, and caches every answer and referral for
// its TTL. A warm cache answers in a millisecond; the same cache keeps serving the old address
// after the record moves, until the TTL that was in force when it was cached runs out.)
//
// The reader resolves names, lets time pass, changes the TTL, moves a record, flushes the cache
// and takes a name server down. Plain state + a pure step function, tested without a browser.

export type Server = "root" | "com" | "net" | "excom" | "exnet";
export const SERVERS: Server[] = ["root", "com", "net", "excom", "exnet"];
export const SERVER_INFO: Record<Server, { label: string; rtt: number; zone: string }> = {
  root: { label: "a.root-servers.net", rtt: 12, zone: "." },
  com: { label: "a.gtld-servers.net", rtt: 20, zone: "com" },
  net: { label: "b.gtld-servers.net", rtt: 24, zone: "net" },
  excom: { label: "ns1.example.com", rtt: 68, zone: "example.com" },
  exnet: { label: "ns.example.net", rtt: 95, zone: "example.net" },
};
/** The stub on the app's host asks a resolver in the same data center. */
export const STUB_MS = 1;
/** How long the resolver waits for a silent name server before trying the next one. */
export const NS_TIMEOUT_MS = 800;
/** TTL on the root's and TLDs' referrals (NS records): two days, as in the real root and .com zones. */
export const REFERRAL_TTL = 172800;

export type Name = "api.example.com" | "www.example.com" | "shop.example.com";
export const NAMES: Name[] = ["api.example.com", "www.example.com", "shop.example.com"];
export type Ttl = 30 | 300 | 3600;
export const TTLS: Ttl[] = [30, 300, 3600];
export const OLD_IP = "203.0.113.10";
export const NEW_IP = "203.0.113.99";

export interface Entry { key: string; type: "A" | "CNAME" | "NS"; value: string; expires: number; ttl: number }

export type StepKind = "stub" | "hit" | "referral" | "answer" | "cname" | "timeout";
export interface Step { kind: StepKind; server?: Server; label: string; ms: number }

export interface Lookup {
  id: number;
  name: Name;
  at: number;
  steps: Step[];
  totalMs: number;
  answer: string;
  queries: number;
  stale: boolean;
  /** Seconds the resolver will keep serving this answer from cache. */
  ttlLeft: number;
}

export interface State {
  now: number;
  apiTtl: Ttl;
  apiIp: string;
  ns1Down: boolean;
  cache: Entry[];
  lookups: Lookup[];
  counts: Record<Server, number>;
  /** Set when the reader moves the api record. */
  move: { at: number; staleUntil: number; hadCache: boolean } | null;
  seq: number;
  note: string | null;
}

export type Action =
  | { type: "resolve"; name: Name }
  | { type: "wait"; seconds: number }
  | { type: "ttl"; ttl: Ttl }
  | { type: "move" }
  | { type: "flush" }
  | { type: "ns1" }
  | { type: "reset" };

export function init(): State {
  return {
    now: 0, apiTtl: 3600, apiIp: OLD_IP, ns1Down: false, cache: [], lookups: [],
    counts: { root: 0, com: 0, net: 0, excom: 0, exnet: 0 }, move: null, seq: 1, note: null,
  };
}

/* ---------------- the zones' data ---------------- */

/** What the authoritative servers say right now. */
function authority(st: State, name: string): { type: "A" | "CNAME"; value: string; ttl: number } | null {
  switch (name) {
    case "api.example.com": return { type: "A", value: st.apiIp, ttl: st.apiTtl };
    case "www.example.com": return { type: "A", value: "203.0.113.20", ttl: 300 };
    case "shop.example.com": return { type: "CNAME", value: "stores.example.net", ttl: 300 };
    case "stores.example.net": return { type: "A", value: "198.51.100.30", ttl: 60 };
  }
  return null;
}

const zoneOf = (name: string) => name.split(".").slice(-2).join(".");
const tldOf = (name: string) => name.split(".").slice(-1)[0];
const authServer = (zone: string): Server => (zone === "example.com" ? "excom" : "exnet");
const tldServer = (tld: string): Server => (tld === "com" ? "com" : "net");

/** The true final address for a name, following CNAMEs at the authorities. */
export function truth(st: State, name: string): string {
  let n = name;
  for (let i = 0; i < 5; i++) {
    const r = authority(st, n);
    if (!r) return "";
    if (r.type === "A") return r.value;
    n = r.value;
  }
  return "";
}

/* ---------------- one recursive resolution ---------------- */

function resolve(st: State, name: Name): State {
  const now = st.now;
  const cache = st.cache.filter((e) => e.expires > now);
  const counts = { ...st.counts };
  const steps: Step[] = [{ kind: "stub", label: `getaddrinfo("${name}") → resolver`, ms: STUB_MS }];
  const get = (key: string, type: Entry["type"]) => cache.find((e) => e.key === key && e.type === type);
  const put = (key: string, type: Entry["type"], value: string, ttl: number) => {
    const i = cache.findIndex((e) => e.key === key && e.type === type);
    const e = { key, type, value, ttl, expires: now + ttl };
    if (i >= 0) cache[i] = e; else cache.push(e);
  };
  const ask = (server: Server) => {
    counts[server]++;
    if (server === "excom" && st.ns1Down) {
      steps.push({ kind: "timeout", server, label: "ns1.example.com: no reply", ms: NS_TIMEOUT_MS });
      counts[server]++;
      return { ms: SERVER_INFO.excom.rtt, via: "ns2.example.com" };
    }
    return { ms: SERVER_INFO[server].rtt, via: SERVER_INFO[server].label };
  };

  let target = name as string;
  let answer = "";
  let ttlLeft = 0;
  for (let guard = 0; guard < 12 && !answer; guard++) {
    const a = get(target, "A");
    if (a) {
      steps.push({ kind: "hit", label: `cache: ${target} A ${a.value} (${a.expires - now} s left)`, ms: 0 });
      answer = a.value; ttlLeft = a.expires - now;
      break;
    }
    const c = get(target, "CNAME");
    if (c) {
      steps.push({ kind: "hit", label: `cache: ${target} CNAME ${c.value}`, ms: 0 });
      target = c.value;
      continue;
    }
    const zone = zoneOf(target), tld = tldOf(target);
    if (get(zone, "NS")) {
      const srv = authServer(zone);
      const { ms, via } = ask(srv);
      const r = authority(st, target)!;
      put(target, r.type, r.value, r.ttl);
      if (r.type === "CNAME") {
        steps.push({ kind: "cname", server: srv, label: `${via}: ${target} is a CNAME for ${r.value}`, ms });
        target = r.value;
      } else {
        steps.push({ kind: "answer", server: srv, label: `${via}: ${target} A ${r.value}, TTL ${r.ttl}`, ms });
        answer = r.value; ttlLeft = r.ttl;
      }
    } else if (get(tld, "NS")) {
      const srv = tldServer(tld);
      const { ms, via } = ask(srv);
      put(zone, "NS", authServer(zone), REFERRAL_TTL);
      steps.push({ kind: "referral", server: srv, label: `${via}: ask ${SERVER_INFO[authServer(zone)].label} for ${zone}`, ms });
    } else {
      const { ms, via } = ask("root");
      put(tld, "NS", tldServer(tld), REFERRAL_TTL);
      steps.push({ kind: "referral", server: "root", label: `${via}: ask ${SERVER_INFO[tldServer(tld)].label} for .${tld}`, ms });
    }
  }
  // The answer travels back to the stub.
  const totalMs = steps.reduce((s, x) => s + x.ms, 0) + STUB_MS;
  const queries = steps.filter((x) => x.server).length;
  const lookup: Lookup = {
    id: st.seq, name, at: now, steps, totalMs, answer, queries,
    stale: answer !== truth(st, name), ttlLeft,
  };
  return { ...st, cache, counts, seq: st.seq + 1, lookups: [lookup, ...st.lookups].slice(0, 12), note: null };
}

/* ---------------- measures ---------------- */

export const liveCache = (st: State) => st.cache.filter((e) => e.expires > st.now);

/** Queries per hour this one resolver sends to example.com's servers for api, if apps ask constantly. */
export const authLoadPerHour = (ttl: Ttl) => Math.ceil(3600 / ttl);

/** How long the resolver will keep serving the old address after the move (seconds). */
export const staleWindow = (st: State) => (st.move ? Math.max(0, st.move.staleUntil - st.move.at) : null);

export interface Goals { warm: boolean; referral: boolean; outage: boolean; migrate: boolean }
export function goals(st: State): Goals {
  const ls = st.lookups;
  const w = staleWindow(st);
  return {
    warm: ls.some((l) => l.queries === 0),
    referral: ls.some((l) => l.queries === 1 && l.steps.some((s) => s.kind === "answer")),
    outage: ls.some((l) => l.steps.some((s) => s.kind === "timeout") && !!l.answer),
    migrate: !!st.move && st.move.hadCache && w !== null && w <= 60,
  };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "resolve":
      return resolve(st, a.name);
    case "wait":
      return { ...st, now: st.now + a.seconds, note: null };
    case "ttl":
      return {
        ...st, apiTtl: a.ttl,
        note: `The zone now says TTL ${a.ttl} s for api.example.com. Copies already in caches keep the TTL they were given${liveCache(st).some((e) => e.key === "api.example.com") ? ": your resolver's copy still has " + (liveCache(st).find((e) => e.key === "api.example.com")!.expires - st.now) + " s to run" : ""}.`,
      };
    case "move": {
      const apiIp = st.apiIp === OLD_IP ? NEW_IP : OLD_IP;
      const cached = liveCache(st).find((e) => e.key === "api.example.com" && e.type === "A");
      const staleUntil = cached ? cached.expires : st.now;
      return {
        ...st, apiIp,
        move: { at: st.now, staleUntil, hadCache: !!cached },
        note: cached
          ? `api.example.com now points at ${apiIp}. Your resolver cached ${cached.value} with TTL ${cached.ttl}, so it will keep answering ${cached.value} for ${cached.expires - st.now} s more.`
          : `api.example.com now points at ${apiIp}. Your resolver has no copy cached, so the next lookup gets the new address.`,
      };
    }
    case "flush":
      return { ...st, cache: [], note: "Resolver cache flushed. The next lookup of any name starts at the root." };
    case "ns1":
      return { ...st, ns1Down: !st.ns1Down, note: st.ns1Down ? "ns1.example.com answers again." : `ns1.example.com stopped answering. A resolver that asks it waits ${NS_TIMEOUT_MS} ms, then tries ns2.example.com.` };
  }
}
