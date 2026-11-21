// CSRF playground: a bank tab, an attacker's page, and the browser in between.
//
// After this, the reader can answer: when another site makes my browser send a request to my
// bank, what decides whether the money moves? (The browser attaches the bank's cookie by its
// own rules, SameSite, whoever started the request. The same-origin policy stops the attacker
// reading responses, not sending requests. So the bank must tell its own pages from others: a
// secret token the attacker cannot read, or the Origin and Sec-Fetch-Site headers the browser
// adds. And state must never change on GET, because every defence exempts GET.)
//
// The reader sets the cookie's SameSite, the token check, the origin check, whether /transfer
// also takes GET, and how long ago they logged in, then fires forged requests from the attacker
// page (a hidden form, an image, a link, fetch, a sibling subdomain, a token theft) and watches
// which ones get through. Plain state + a pure step function.

export type SameSite = "none" | "default" | "lax" | "strict";
export const SAMESITE_NAME: Record<SameSite, string> = {
  none: "SameSite=None",
  default: "not set (Chrome treats as Lax)",
  lax: "SameSite=Lax",
  strict: "SameSite=Strict",
};

export const BANK = "https://bank.example";
export type From = "bank" | "attacker" | "sibling";
export const ORIGIN: Record<From, string> = {
  bank: "https://bank.example",
  attacker: "https://deals.example",
  sibling: "https://community.bank.example",
};
/** How the request's initiator relates to bank.example (site = scheme + registrable domain). */
export const RELATION: Record<From, "same-origin" | "same-site" | "cross-site"> = {
  bank: "same-origin",
  attacker: "cross-site",
  sibling: "same-site",
};

export type Kind = "form" | "img" | "link" | "fetch" | "fetch-json" | "steal";
export interface Attack { id: string; from: From; kind: Kind; title: string; snippet: string }

export const ATTACKS: Attack[] = [
  { id: "form", from: "attacker", kind: "form", title: "Hidden form, auto-submitted",
    snippet: `<form method="POST" action="${BANK}/transfer">\n  <input name="to" value="mallory"><input name="amount" value="250">\n</form>\n<script>document.forms[0].submit()</script>` },
  { id: "img", from: "attacker", kind: "img", title: "Image tag",
    snippet: `<img src="${BANK}/transfer?to=mallory&amount=250">` },
  { id: "link", from: "attacker", kind: "link", title: "Link the user clicks",
    snippet: `<a href="${BANK}/transfer?to=mallory&amount=250">Claim your prize</a>` },
  { id: "fetch", from: "attacker", kind: "fetch", title: "fetch() with credentials",
    snippet: `fetch("${BANK}/transfer", {\n  method: "POST", credentials: "include",\n  body: new URLSearchParams({ to: "mallory", amount: "250" }),\n})` },
  { id: "fetch-json", from: "attacker", kind: "fetch-json", title: "fetch() sending JSON",
    snippet: `fetch("${BANK}/transfer", {\n  method: "POST", credentials: "include",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ to: "mallory", amount: 250 }),\n})` },
  { id: "steal", from: "attacker", kind: "steal", title: "Read the token first",
    snippet: `const page = await fetch("${BANK}/account", { credentials: "include" });\nconst token = (await page.text()).match(/csrf" value="(\\w+)/)[1];` },
  { id: "sibling", from: "sibling", kind: "form", title: "Hidden form on a sibling subdomain",
    snippet: `<!-- a post on community.bank.example, which allows HTML -->\n<form method="POST" action="${BANK}/transfer"> … </form>` },
];

export interface Defences {
  sameSite: SameSite;
  token: boolean;
  originCheck: boolean;
  acceptGet: boolean;
  /** Logged in under two minutes ago (Chrome's Lax+POST allowance for cookies without SameSite). */
  freshLogin: boolean;
}

export type CheckId = "sent" | "method" | "cookie" | "origin" | "token";
export type CheckResult = "pass" | "fail" | "skip";
export interface Check { id: CheckId; result: CheckResult; why: string }

export interface Outcome {
  attack: string;
  /** The defences in force when it was fired. */
  d: Defences;
  from: From;
  method: "GET" | "POST";
  /** Did the request leave the browser at all? */
  sent: boolean;
  cookie: boolean;
  headers: { origin: string | null; secFetchSite: string };
  checks: Check[];
  status: number | null;
  /** The money moved. */
  transferred: boolean;
  /** For the token theft: did the attacker read the response? */
  readResponse: boolean;
  why: string;
}

const isNavigation = (k: Kind) => k === "form" || k === "link";
const methodOf = (k: Kind): "GET" | "POST" => (k === "img" || k === "link" || k === "steal" ? "GET" : "POST");

/** Does the browser attach the bank's session cookie to this request? */
export function attachCookie(d: Defences, from: From, kind: Kind): { yes: boolean; why: string } {
  const rel = RELATION[from];
  if (rel !== "cross-site") return { yes: true, why: rel === "same-origin" ? "same origin: cookie sent" : "community.bank.example is the same site as bank.example, so SameSite sends the cookie" };
  const m = methodOf(kind);
  switch (d.sameSite) {
    case "none": return { yes: true, why: "SameSite=None: sent on every cross-site request" };
    case "strict": return { yes: false, why: "SameSite=Strict: never sent cross-site" };
    case "lax":
      return isNavigation(kind) && m === "GET"
        ? { yes: true, why: "Lax sends the cookie on a top-level GET navigation" }
        : { yes: false, why: "Lax withholds the cookie on cross-site POSTs and subresources" };
    case "default":
      if (isNavigation(kind) && m === "GET") return { yes: true, why: "default Lax sends the cookie on a top-level GET navigation" };
      if (isNavigation(kind) && m === "POST" && d.freshLogin) return { yes: true, why: "default Lax still sends it on a top-level POST within two minutes of the cookie being set" };
      return { yes: false, why: "default Lax withholds the cookie on cross-site POSTs and subresources" };
  }
}

/** One request through the browser and the bank's checks. */
export function fire(d: Defences, a: Attack): Outcome {
  const method = methodOf(a.kind);
  const rel = RELATION[a.from];
  const secFetchSite = rel;
  // Browsers send Origin on POST (and on CORS-mode fetches); not on image loads or plain link navigations.
  const origin = method === "POST" || a.kind === "steal" ? ORIGIN[a.from] : null;
  const checks: Check[] = [];
  const base = { attack: a.id, d: { ...d }, from: a.from, method, headers: { origin, secFetchSite } };

  if (a.kind === "fetch-json") {
    checks.push({ id: "sent", result: "fail", why: "Content-Type: application/json is not a simple request, so the browser sends a CORS preflight first. The bank allows no other origin, so the POST is never sent." });
    return { ...base, sent: false, cookie: false, checks, status: null, transferred: false, readResponse: false, why: "blocked by the CORS preflight: the POST never left the browser" };
  }
  checks.push({ id: "sent", result: "pass", why: a.kind === "fetch" ? "a form-encoded POST is a simple request: no preflight, it is sent straight away" : "the browser sends it" });

  const ck = attachCookie(d, a.from, a.kind);

  if (a.kind === "steal") {
    // GET /account is allowed and the page renders, but the response is cross-origin.
    checks.push({ id: "cookie", result: ck.yes ? "pass" : "fail", why: ck.why });
    return { ...base, sent: true, cookie: ck.yes, checks, status: ck.yes ? 200 : 401, transferred: false, readResponse: false,
      why: "the request went out, but the same-origin policy hides a cross-origin response from the page's script, so the token stays secret" };
  }

  if (method === "GET" && !d.acceptGet) {
    checks.push({ id: "method", result: "fail", why: "POST /transfer only: a GET gets 405" });
    return { ...base, sent: true, cookie: ck.yes, checks, status: 405, transferred: false, readResponse: false, why: "the endpoint does not change state on GET" };
  }
  checks.push({ id: "method", result: "pass", why: method === "GET" ? "the endpoint also accepts GET" : "POST" });

  checks.push({ id: "cookie", result: ck.yes ? "pass" : "fail", why: ck.why });
  if (!ck.yes) return { ...base, sent: true, cookie: false, checks, status: 401, transferred: false, readResponse: false, why: "no session cookie, so the bank sees an anonymous request" };

  // Middleware such as Go's CrossOriginProtection, Django's CsrfViewMiddleware and most token
  // libraries exempt safe methods, so a GET skips both checks.
  const safe = method === "GET";
  if (d.originCheck) {
    if (safe) checks.push({ id: "origin", result: "skip", why: "GET is exempt: it is supposed to be safe" });
    else {
      const ok = secFetchSite === "same-origin";
      checks.push({ id: "origin", result: ok ? "pass" : "fail", why: ok ? "Sec-Fetch-Site: same-origin" : `Sec-Fetch-Site: ${secFetchSite}, Origin: ${origin}` });
      if (!ok) return { ...base, sent: true, cookie: true, checks, status: 403, transferred: false, readResponse: false, why: "the origin check saw a request started by another origin" };
    }
  }
  if (d.token) {
    if (safe) checks.push({ id: "token", result: "skip", why: "GET is exempt from the token check" });
    else {
      const has = a.from === "bank";
      checks.push({ id: "token", result: has ? "pass" : "fail", why: has ? "the form carries the token from this session" : "no token: the attacker could not read it from the bank's page" });
      if (!has) return { ...base, sent: true, cookie: true, checks, status: 403, transferred: false, readResponse: false, why: "the request had the cookie but not the token" };
    }
  }
  return { ...base, sent: true, cookie: true, checks, status: 303, transferred: true, readResponse: false,
    why: a.from === "bank" ? "your own transfer, as intended" : "the bank saw a logged-in user asking for a transfer and did it" };
}

/** The user's own transfer from the bank's page: must keep working whatever the defences. */
export const OWN: Attack = { id: "own", from: "bank", kind: "form", title: "Your own transfer form", snippet: "" };

/* ---------------- state ---------------- */

export interface Ledger { n: number; text: string; amount: number; forged: boolean }

export interface State extends Defences {
  balance: number;
  ledger: Ledger[];
  last: Outcome | null;
  fired: Outcome[];
}

export type Action =
  | { type: "sameSite"; value: SameSite }
  | { type: "toggle"; key: "token" | "originCheck" | "acceptGet" | "freshLogin" }
  | { type: "fire"; id: string }
  | { type: "reset" };

export function init(): State {
  return { sameSite: "none", token: false, originCheck: false, acceptGet: false, freshLogin: false, balance: 2000, ledger: [], last: null, fired: [] };
}

export const defencesOf = (s: State): Defences => ({ sameSite: s.sameSite, token: s.token, originCheck: s.originCheck, acceptGet: s.acceptGet, freshLogin: s.freshLogin });

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset": return init();
    case "sameSite": return { ...st, sameSite: a.value };
    case "toggle": return { ...st, [a.key]: !st[a.key] };
    case "fire": {
      const atk = a.id === OWN.id ? OWN : ATTACKS.find((x) => x.id === a.id);
      if (!atk) return st;
      const out = fire(defencesOf(st), atk);
      const n = (st.ledger[st.ledger.length - 1]?.n ?? 0) + 1;
      const ledger = out.transferred
        ? [...st.ledger, { n, amount: 250, forged: atk.from !== "bank", text: atk.from === "bank" ? "250 to landlord (you)" : `250 to mallory (${atk.title.toLowerCase()})` }].slice(-10)
        : st.ledger;
      return { ...st, balance: out.transferred ? st.balance - 250 : st.balance, ledger, last: out, fired: [...st.fired, out].slice(-40) };
    }
  }
}

/** Every attack against the current defences, without moving money: the matrix in the view. */
export function matrix(d: Defences): Outcome[] {
  return ATTACKS.map((a) => fire(d, a));
}

export const forgedThrough = (d: Defences) => matrix(d).filter((o) => o.transferred).length;
export const ownWorks = (d: Defences) => fire(d, OWN).transferred;

export interface Goals { corsMyth: boolean; laxGet: boolean; sibling: boolean; allBlocked: boolean }
export function goals(st: State): Goals {
  return {
    corsMyth: st.fired.some((o) => o.attack === "fetch" && o.transferred),
    laxGet: st.fired.some((o) => o.from === "attacker" && o.transferred && (o.d.sameSite === "lax" || o.d.sameSite === "default")),
    sibling: st.fired.some((o) => o.attack === "sibling" && o.transferred),
    allBlocked: forgedThrough(defencesOf(st)) === 0 && ownWorks(defencesOf(st)) && st.fired.length > 0,
  };
}
