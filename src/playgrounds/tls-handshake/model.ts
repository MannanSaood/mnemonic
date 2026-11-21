// TLS playground: one client, one server (and sometimes someone in between), one handshake.
//
// After this, the reader can answer: what happens in the round trips before the first encrypted
// request, and which check stops an impostor? (TLS 1.3 needs one round trip after TCP, TLS 1.2
// two. The key exchange alone gives you a secret shared with whoever answered; the certificate
// checks, chain to a trusted root, dates, name and the signature over the handshake, are what
// make that someone the server you named.)
//
// The reader picks a version, resumption and a round-trip time, breaks the certificate chain or
// puts an attacker in the path, switches verification off, and connects. Each connection is
// traced message by message, with every check the client ran and the exact error it raised.
// Plain state + a pure step function, so it can be tested without a browser.

export type Version = "1.2" | "1.3";
export type Rtt = 20 | 80 | 200;
export const RTTS: Rtt[] = [20, 80, 200];
export type Attacker = "none" | "own" | "copied";
export type Resume = "off" | "ticket" | "early";

export interface Breaks { expired: boolean; wrongName: boolean; noIntermediate: boolean; untrustedRoot: boolean }
export type BreakKey = keyof Breaks;

export type CheckId = "chain" | "dates" | "name" | "signature";
export const CHECKS: CheckId[] = ["chain", "dates", "name", "signature"];
export const CHECK_NAME: Record<CheckId, string> = {
  chain: "Chain ends at a root I trust",
  dates: "Every certificate is within its dates",
  name: "Leaf is valid for api.example.com",
  signature: "Server signed this handshake with the leaf's key",
};

export type Side = "client" | "server";
export interface Msg {
  /** Half-round-trip index: even legs go client → server, odd legs come back. */
  leg: number;
  from: Side;
  label: string;
  /** Sent encrypted? A passive observer sees plaintext labels in full. */
  enc: boolean;
  kind: "tcp" | "hello" | "hs" | "data" | "alert";
}

export type CheckResult = "pass" | "fail" | "skipped" | "not-run";
export type Outcome = "ok" | "refused" | "mitm";

export interface Run {
  n: number;
  version: Version;
  resumed: boolean;
  early: boolean;
  rtt: Rtt;
  attacker: Attacker;
  verify: boolean;
  breaks: Breaks;
  msgs: Msg[];
  checks: Record<CheckId, CheckResult>;
  failed: CheckId | null;
  /** Which kind of chain failure, for the error text. */
  chainWhy: "intermediate" | "root" | "self" | null;
  outcome: Outcome;
  /** Round trips (TCP included) before the request leaves; null if it never does. */
  requestRtts: number | null;
  /** ms until the first response byte reaches the client; null if never. */
  firstByteMs: number | null;
  /** Messages a passive observer could read in full. */
  plaintext: string[];
}

export interface State {
  version: Version;
  resume: Resume;
  rtt: Rtt;
  attacker: Attacker;
  verify: boolean;
  breaks: Breaks;
  /** The client holds a ticket from a good full handshake with the real server. */
  ticket: boolean;
  runs: Run[];
}

export type Action =
  | { type: "version"; version: Version }
  | { type: "resume"; resume: Resume }
  | { type: "rtt"; rtt: Rtt }
  | { type: "break"; key: BreakKey }
  | { type: "attacker"; attacker: Attacker }
  | { type: "verify" }
  | { type: "connect" }
  | { type: "reset" };

export const noBreaks = (): Breaks => ({ expired: false, wrongName: false, noIntermediate: false, untrustedRoot: false });

export function init(): State {
  return { version: "1.3", resume: "off", rtt: 80, attacker: "none", verify: true, breaks: noBreaks(), ticket: false, runs: [] };
}

/* ---------------- the client's checks ---------------- */

interface Verdict { checks: Record<CheckId, CheckResult>; failed: CheckId | null; chainWhy: Run["chainWhy"] }

/** What the client checks after it receives the server's certificate flight. */
export function verifyPeer(verify: boolean, attacker: Attacker, b: Breaks): Verdict {
  const checks: Record<CheckId, CheckResult> = { chain: "not-run", dates: "not-run", name: "not-run", signature: "not-run" };
  const order: CheckId[] = ["chain", "dates", "name"];
  // The real certificate chain is presented unless the attacker brings its own.
  const own = attacker === "own";
  let chainWhy: Run["chainWhy"] = null;
  const fails: Record<CheckId, boolean> = {
    chain: own || b.noIntermediate || b.untrustedRoot,
    dates: !own && b.expired,
    name: !own && b.wrongName,
    // The attacker who copied the real chain does not hold the leaf's private key.
    signature: attacker === "copied",
  };
  if (own) chainWhy = "self"; else if (b.noIntermediate) chainWhy = "intermediate"; else if (b.untrustedRoot) chainWhy = "root";
  for (const c of order) {
    if (!verify) { checks[c] = "skipped"; continue; }
    if (fails[c]) { checks[c] = "fail"; return { checks, failed: c, chainWhy }; }
    checks[c] = "pass";
  }
  // Even with verification off, the handshake signature is checked against the presented key.
  if (fails.signature) { checks.signature = "fail"; return { checks, failed: "signature", chainWhy }; }
  checks.signature = "pass";
  return { checks, failed: null, chainWhy };
}

/* ---------------- one connection ---------------- */

export function connect(st: State, n = (st.runs[st.runs.length - 1]?.n ?? 0) + 1): Run {
  const v = st.version;
  // A ticket only works with the server that issued it; an attacker cannot accept it.
  const resumed = st.resume !== "off" && st.ticket && st.attacker === "none";
  const early = resumed && v === "1.3" && st.resume === "early";
  const msgs: Msg[] = [
    { leg: 0, from: "client", label: "SYN", enc: false, kind: "tcp" },
    { leg: 1, from: "server", label: "SYN-ACK", enc: false, kind: "tcp" },
    { leg: 2, from: "client", label: "ACK", enc: false, kind: "tcp" },
  ];
  const hello = `ClientHello · SNI api.example.com · ${v === "1.3" ? "key share" : "cipher list"}${resumed ? " · ticket" : ""}`;
  msgs.push({ leg: 2, from: "client", label: hello, enc: false, kind: "hello" });

  let verdict: Verdict = { checks: { chain: "not-run", dates: "not-run", name: "not-run", signature: "not-run" }, failed: null, chainWhy: null };
  let requestLeg: number | null = null;

  if (v === "1.3") {
    if (early) msgs.push({ leg: 2, from: "client", label: "early data: POST /v1/payouts (replayable)", enc: true, kind: "data" });
    msgs.push({ leg: 3, from: "server", label: `ServerHello · key share${resumed ? " · ticket accepted" : ""}`, enc: false, kind: "hello" });
    if (resumed) {
      msgs.push({ leg: 3, from: "server", label: "EncryptedExtensions · Finished (no certificate: the ticket proves it)", enc: true, kind: "hs" });
      msgs.push({ leg: 4, from: "client", label: "Finished", enc: true, kind: "hs" });
      requestLeg = early ? 2 : 4;
    } else {
      msgs.push({ leg: 3, from: "server", label: "EncryptedExtensions · Certificate · CertificateVerify · Finished", enc: true, kind: "hs" });
      verdict = verifyPeer(st.verify, st.attacker, st.breaks);
      if (verdict.failed) msgs.push({ leg: 4, from: "client", label: `alert: ${alertName(verdict.failed)}`, enc: true, kind: "alert" });
      else { msgs.push({ leg: 4, from: "client", label: "Finished", enc: true, kind: "hs" }); requestLeg = 4; }
    }
  } else {
    if (resumed) {
      msgs.push({ leg: 3, from: "server", label: "ServerHello · ChangeCipherSpec · Finished (session resumed)", enc: false, kind: "hello" });
      msgs.push({ leg: 4, from: "client", label: "ChangeCipherSpec · Finished", enc: true, kind: "hs" });
      requestLeg = 4;
    } else {
      msgs.push({ leg: 3, from: "server", label: "ServerHello · Certificate · ServerKeyExchange (signed) · ServerHelloDone", enc: false, kind: "hello" });
      verdict = verifyPeer(st.verify, st.attacker, st.breaks);
      if (verdict.failed) msgs.push({ leg: 4, from: "client", label: `alert: ${alertName(verdict.failed)}`, enc: false, kind: "alert" });
      else {
        msgs.push({ leg: 4, from: "client", label: "ClientKeyExchange · ChangeCipherSpec · Finished", enc: false, kind: "hs" });
        msgs.push({ leg: 5, from: "server", label: "ChangeCipherSpec · Finished", enc: true, kind: "hs" });
        requestLeg = 6;
      }
    }
  }
  if (requestLeg !== null) {
    if (!early) msgs.push({ leg: requestLeg, from: "client", label: "POST /v1/payouts · Authorization: Bearer …", enc: true, kind: "data" });
    msgs.push({ leg: requestLeg + 1, from: "server", label: "201 Created", enc: true, kind: "data" });
  }
  msgs.sort((a, b) => a.leg - b.leg);

  const outcome: Outcome = verdict.failed ? "refused" : st.attacker !== "none" && !resumed ? "mitm" : "ok";
  return {
    n, version: v, resumed, early, rtt: st.rtt, attacker: resumed ? "none" : st.attacker, verify: st.verify, breaks: { ...st.breaks },
    msgs, checks: verdict.checks, failed: verdict.failed, chainWhy: verdict.chainWhy, outcome,
    requestRtts: requestLeg === null ? null : requestLeg / 2,
    firstByteMs: requestLeg === null ? null : ((requestLeg + 2) / 2) * st.rtt,
    plaintext: msgs.filter((m) => !m.enc && m.kind !== "tcp").map((m) => m.label),
  };
}

export function alertName(c: CheckId): string {
  return c === "chain" ? "unknown_ca" : c === "dates" ? "certificate_expired" : c === "name" ? "bad_certificate" : "decrypt_error";
}

/* ---------------- goals ---------------- */

export interface Goals { oneRtt: boolean; allChecks: boolean; leaked: boolean; stopped: boolean }
export function goals(runs: Run[]): Goals {
  const failed = new Set(runs.map((r) => r.failed).filter(Boolean));
  return {
    oneRtt: runs.some((r) => r.requestRtts === 1),
    allChecks: CHECKS.every((c) => failed.has(c)),
    leaked: runs.some((r) => r.outcome === "mitm"),
    stopped: runs.some((r) => r.attacker === "copied" && r.failed === "signature"),
  };
}

/* ---------------- step ---------------- */

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "version":
      return { ...st, version: a.version, ticket: false };
    case "resume":
      return { ...st, resume: a.resume };
    case "rtt":
      return { ...st, rtt: a.rtt };
    case "break":
      return { ...st, breaks: { ...st.breaks, [a.key]: !st.breaks[a.key] } };
    case "attacker":
      return { ...st, attacker: a.attacker };
    case "verify":
      return { ...st, verify: !st.verify };
    case "connect": {
      const run = connect(st);
      // A good full handshake with the real server leaves the client a ticket for next time.
      const ticket = st.ticket || (run.outcome === "ok" && !run.resumed);
      return { ...st, ticket, runs: [...st.runs, run].slice(-12) };
    }
  }
}
