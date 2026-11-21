// Lifetimes playground: the regions of one request handler on a timeline.
//
// Purpose. After this, the reader can answer: "How long may I keep a reference that a function
// returned, and why does the compiler reject code that would have worked at runtime?"
// `fn tenant_key<'a>(head: &'a str, default_tenant: &'a str) -> &'a str` says the result may
// borrow from either input, so the caller may use it only inside 'a, the region where BOTH are
// alive. The compiler checks the call against the signature, never against which branch the
// body takes at runtime. Annotations change no value's life: to compile, you move code (drop
// later, use earlier), or you stop borrowing (return an owned String, at the cost of a copy).
//
// The reader drags drop(head) and the last use of key along the timeline, switches between four
// signatures, toggles whether this request carries an X-Tenant header, and can run a rejected
// layout "without the checker" to see the dangling read it would have done.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Sig = "both" | "elided" | "fallback" | "owned";
export const SIGS: Sig[] = ["both", "elided", "fallback", "owned"];

export const SIG_CODE: Record<Sig, string> = {
  both: "fn tenant_key<'a>(head: &'a str, default_tenant: &'a str) -> &'a str",
  elided: "fn tenant_key(head: &str, default_tenant: &str) -> &str",
  fallback: "fn tenant_key<'a, 'b>(head: &'a str, default_tenant: &'b str) -> &'b str",
  owned: "fn tenant_key(head: &str, default_tenant: &str) -> String",
};

/** The body is the same for every signature (plus .to_owned() for String). */
export const BODY = 'header(head, "x-tenant").unwrap_or(default_tenant)';

/** Lines of serve(). Rows 4..7 use key; drop(head) is placed after row `drop`. */
export const ROWS: string[] = [
  "let cfg = &app.config; // lives as long as the server",
  "let head = conn.read_head().await?; // 16 KiB",
  "let key = tenant_key(&head, &cfg.default_tenant);",
  "limiter.take(key, 1)?;",
  "audit.note(key);",
  "stats.bump(key);",
  "last_seen.insert(key, now);",
  "respond(conn).await?;",
];
export const KEY_ROW = 3;
export const USE_ROWS = [4, 5, 6, 7];
export const DROP_MIN = 3;
export const DROP_MAX = ROWS.length; // after the last row: the closing brace

export interface Verdict {
  ok: boolean;
  code: "E0106" | "E0505" | "lifetime" | null;
  /** Where the error is reported: "sig", "body", or a row number. */
  at: "sig" | "body" | number | null;
  message: string;
  notes: { at: number | "sig" | "body"; text: string }[];
}

export interface Region { from: number; to: number }

export interface Outcome { kind: "dangling" | "luck" | "fine"; rows: number[]; text: string }

export type ChallengeId = "luck" | "dangle" | "fit" | "owned" | "body";
export const CHALLENGES: { id: ChallengeId; text: string }[] = [
  { id: "luck", text: "Find a rejected layout that this request would have run without harm." },
  { id: "dangle", text: "Run a rejected layout on a request with the header and find the freed read." },
  { id: "fit", text: "Make it compile with the 'a signature, by moving drop(head) or the last use of key." },
  { id: "owned", text: "Make it compile without moving any line." },
  { id: "body", text: "Tie the result to default_tenant only, and see where the error moves." },
];

export type Guess = "yes" | "no" | "warn";
export const ANSWER: Guess = "no";

export interface Tried { ok: boolean; dangles: boolean }

export interface State {
  sig: Sig;
  /** drop(head) runs after this row. */
  drop: number;
  /** Last row that uses key. */
  lastUse: number;
  /** This request carries an X-Tenant header, so tenant_key returns a slice of head. */
  header: boolean;
  unchecked: boolean;
  guess: Guess | null;
  tried: Record<string, Tried>;
  edits: number;
  done: ChallengeId[];
}

export type Action =
  | { type: "sig"; sig: Sig }
  | { type: "drop"; row: number }
  | { type: "lastUse"; row: number }
  | { type: "header"; on: boolean }
  | { type: "unchecked"; on: boolean }
  | { type: "guess"; guess: Guess }
  | { type: "reset" };

/* ---------------- regions and the checker ---------------- */

export const cfgRegion: Region = { from: 1, to: ROWS.length + 1 };
export const headRegion = (s: Pick<State, "drop">): Region => ({ from: 2, to: s.drop });
export const keyRegion = (s: Pick<State, "lastUse">): Region => ({ from: KEY_ROW, to: s.lastUse });

/** The region the signature allows key to be used in, or null if there is none to draw. */
export function allowed(s: Pick<State, "sig" | "drop">): Region | null {
  if (s.sig === "both") return { from: KEY_ROW, to: Math.min(headRegion(s).to, cfgRegion.to) };
  if (s.sig === "fallback") return { from: KEY_ROW, to: cfgRegion.to };
  return null;
}

export function verdict(s: Pick<State, "sig" | "drop" | "lastUse">): Verdict {
  if (s.sig === "elided") {
    return {
      ok: false, code: "E0106", at: "sig", message: "missing lifetime specifier",
      notes: [{ at: "sig", text: "this function's return type contains a borrowed value, but the signature does not say whether it is borrowed from `head` or `default_tenant`" }],
    };
  }
  if (s.sig === "fallback") {
    return {
      ok: false, code: "lifetime", at: "body", message: "lifetime may not live long enough",
      notes: [{ at: "body", text: "function was supposed to return data with lifetime `'b` but it is returning data with lifetime `'a`" }],
    };
  }
  if (s.sig === "owned" || s.lastUse <= s.drop) return { ok: true, code: null, at: null, message: "", notes: [] };
  const later = USE_ROWS.find((r) => r > s.drop && r <= s.lastUse)!;
  return {
    ok: false, code: "E0505", at: s.drop, message: "cannot move out of `head` because it is borrowed",
    notes: [
      { at: KEY_ROW, text: "borrow of `head` occurs here" },
      { at: s.drop, text: "move out of `head` occurs here (drop(head))" },
      { at: later, text: "borrow later used here, by key" },
    ],
  };
}

/** What a rejected layout would do if it ran anyway, on this request. */
export function outcome(s: Pick<State, "sig" | "drop" | "lastUse" | "header">): Outcome {
  if (s.sig === "owned") return { kind: "fine", rows: [], text: "key is a String of its own, about 12 bytes, copied from head on line 3. drop(head) frees head and key is unaffected." };
  const late = USE_ROWS.filter((r) => r > s.drop && r <= s.lastUse);
  if (late.length === 0) return { kind: "fine", rows: [], text: "Every use of key comes before drop(head), so key never outlives what it points at." };
  if (!s.header) {
    return { kind: "luck", rows: late, text: `This request has no X-Tenant header, so key points at the config's default tenant, which is still alive. Lines ${late.join(", ")} would work. The next request with the header would not, and the compiler cannot tell them apart.` };
  }
  return { kind: "dangling", rows: late, text: `key points into head's 16 KiB, and drop(head) after line ${s.drop} freed them. Lines ${late.join(", ")} read freed memory: whatever the allocator put there next, often the next request's headers.` };
}

/* ---------------- state ---------------- */

const key = (s: State) => `${s.sig}|${s.drop}|${s.lastUse}`;

function record(s: State, acted: boolean) {
  const v = verdict(s);
  const withHeader = outcome({ ...s, header: true });
  s.tried = { ...s.tried, [key(s)]: { ok: v.ok, dangles: !v.ok && withHeader.kind === "dangling" } };
  if (!acted) return;
  const achieve = (c: ChallengeId) => { if (!s.done.includes(c)) s.done = [...s.done, c]; };
  const o = outcome(s);
  if (!v.ok && o.kind === "luck") achieve("luck");
  if (!v.ok && s.unchecked && o.kind === "dangling") achieve("dangle");
  if (v.ok && s.sig === "both") achieve("fit");
  if (v.ok && s.sig === "owned" && s.lastUse > s.drop) achieve("owned");
  if (s.sig === "fallback") achieve("body");
}

/** The start: head is dropped right after the limiter check, to free 16 KiB before slower work. */
export function init(): State {
  const s: State = { sig: "both", drop: 4, lastUse: 7, header: false, unchecked: false, guess: null, tried: {}, edits: 0, done: [] };
  record(s, false);
  return s;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "guess":
      return st.edits > 0 ? st : { ...st, guess: a.guess };
    case "sig": {
      if (!SIGS.includes(a.sig) || a.sig === st.sig) return st;
      const s = { ...st, sig: a.sig, edits: st.edits + 1 };
      record(s, true);
      return s;
    }
    case "drop": {
      if (a.row < DROP_MIN || a.row > DROP_MAX || a.row === st.drop) return st;
      const s = { ...st, drop: a.row, edits: st.edits + 1 };
      record(s, true);
      return s;
    }
    case "lastUse": {
      if (!USE_ROWS.includes(a.row) || a.row === st.lastUse) return st;
      const s = { ...st, lastUse: a.row, edits: st.edits + 1 };
      record(s, true);
      return s;
    }
    case "header": {
      const s = { ...st, header: a.on, edits: st.edits + 1 };
      record(s, true);
      return s;
    }
    case "unchecked": {
      const s = { ...st, unchecked: a.on, edits: st.edits + 1 };
      record(s, true);
      return s;
    }
  }
}

export const revealed = (s: State) => s.edits > 0;

export function stats(s: State) {
  const all = Object.values(s.tried);
  return {
    tried: all.length,
    rejected: all.filter((t) => !t.ok).length,
    dangles: all.filter((t) => t.dangles).length,
    accepted: all.filter((t) => t.ok).length,
  };
}
