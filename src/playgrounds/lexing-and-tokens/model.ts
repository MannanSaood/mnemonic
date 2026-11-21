// Lexing playground: an alert-rule language (`cpu >= 0.9 and env == "prod eu"`) scanned one
// token at a time, next to the naive "split on spaces" version it replaces.
//
// After this, the reader can answer: how does a lexer turn a rule into tokens (one pass, one
// character of lookahead, longest match), and why does splitting on spaces get the same rule
// wrong as soon as someone leaves out a space or puts one inside a string?
//
// The reader types or picks a rule, steps the scanner token by token (the cursor shows start and
// current position), and compares the token chips with the words that split() produces. Break-it:
// turn off longest match and `>=` becomes `>` plus a stray `=`; leave a string open and the error
// token stops at the end of the line, so scanning resumes on the next one.
//
// The lexer here is also used by the pratt-parsing and bytecode-and-stack-vm playgrounds.
// Plain state + a pure step function, so it can be tested without a browser.

export type Kind = "ident" | "keyword" | "number" | "string" | "op" | "error" | "eof";

export interface Token {
  kind: Kind;
  text: string;
  start: number;
  end: number;
  line: number;
  col: number;
  /** Why the scanner made this token, one line. */
  why: string;
  /** Lookahead peeks spent deciding this token. */
  peeks: number;
  /** Characters skipped (whitespace, comments) before this token. */
  skipped: number;
  message?: string;
}

export interface LexOptions { munch: boolean }
export interface LexResult { tokens: Token[]; reads: number; peeks: number; errors: Token[] }

export const KEYWORDS = ["and", "or", "not", "true", "false"];
const isDigit = (c: string) => c >= "0" && c <= "9";
const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const show = (c: string) => (c === "\n" ? "end of line" : c === "" ? "end of input" : `'${c}'`);

/** Scan the whole rule. Never throws: bad input becomes error tokens and scanning goes on. */
export function lex(src: string, opts: LexOptions = { munch: true }): LexResult {
  const tokens: Token[] = [];
  let pos = 0;
  let peeks = 0;
  const peek = () => src[pos] ?? "";
  const lineCol = (at: number) => {
    const before = src.slice(0, at);
    const line = before.split("\n").length;
    return { line, col: at - before.lastIndexOf("\n") };
  };

  for (;;) {
    // skip whitespace and # comments
    const skipFrom = pos;
    for (;;) {
      if (isSpace(peek())) pos++;
      else if (peek() === "#") { while (pos < src.length && peek() !== "\n") pos++; }
      else break;
    }
    const skipped = pos - skipFrom;
    const start = pos;
    let p = 0;
    const emit = (kind: Kind, why: string, message?: string): Token => {
      const t: Token = { kind, text: src.slice(start, pos), start, end: pos, ...lineCol(start), why, peeks: p, skipped, message };
      tokens.push(t);
      peeks += p;
      return t;
    };
    if (pos >= src.length) { emit("eof", "No characters left: end of input."); break; }

    const c = src[pos++];
    if ("<>=!".includes(c)) {
      const next = peek();
      if (opts.munch) {
        p++;
        if (next === "=") {
          pos++;
          emit("op", `Read '${c}', peeked at '=': longest match takes both, so this is one operator, ${c}=.`);
          continue;
        }
      }
      if (c === "=" || c === "!") {
        emit("error", opts.munch
          ? `Read '${c}' and peeked at ${show(next)}. A lone ${c} is not an operator in this language.`
          : `Read '${c}'. Longest match is off, so the scanner did not look ahead and ${c} stands alone.`,
          c === "=" ? "'=' is not an operator; use ==" : "'!' is not an operator; use != or not");
        continue;
      }
      emit("op", opts.munch ? `Read '${c}', peeked at ${show(next)}: not '=', so the operator is just ${c}.` : `Read '${c}'. Longest match is off, so it ends here without a peek.`);
      continue;
    }
    if ("+-*/()".includes(c)) { emit("op", `Read '${c}'. It can only be a one-character operator.`); continue; }
    if (c === '"') {
      while (pos < src.length && peek() !== '"' && peek() !== "\n") pos++;
      if (peek() === '"') { pos++; emit("string", "Read a quote, then everything up to the closing quote, spaces included."); continue; }
      emit("error", `Read a quote but hit ${show(peek())} before the closing one. The error token stops there, so scanning resumes on the next line.`, "unterminated string");
      continue;
    }
    if (isDigit(c)) {
      while (isDigit(peek())) pos++;
      if (peek() === ".") {
        p++;
        if (isDigit(src[pos + 1] ?? "")) { pos++; while (isDigit(peek())) pos++; }
      }
      emit("number", "Read digits, and a fraction if a digit follows the dot.");
      continue;
    }
    if (isLetter(c)) {
      while (isLetter(peek()) || isDigit(peek())) pos++;
      const w = src.slice(start, pos);
      if (KEYWORDS.includes(w)) emit("keyword", `Read a word, looked '${w}' up in the keyword table: found, so it is a keyword.`);
      else emit("ident", `Read a word, looked '${w}' up in the keyword table: not there, so it is a name.`);
      continue;
    }
    emit("error", `'${c}' cannot start any token. Report it with its position and carry on.`, `unexpected character '${c}'`);
  }
  return { tokens, reads: src.length, peeks, errors: tokens.filter((t) => t.kind === "error") };
}

/* ---------------- the naive version: split on whitespace ---------------- */

export interface Word { text: string; start: number; end: number; ok: boolean }

/** Words as `rule.split(/\s+/)` sees them, each marked ok if it is exactly one real token. */
export function splitWords(src: string, tokens: Token[]): Word[] {
  const out: Word[] = [];
  const re = /\S+/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index, end = m.index + m[0].length;
    out.push({ text: m[0], start, end, ok: tokens.some((t) => t.kind !== "error" && t.start === start && t.end === end) });
  }
  return out;
}

/* ---------------- presets and challenges ---------------- */

export interface Preset { label: string; src: string }
export const PRESETS: Preset[] = [
  { label: "As tested", src: 'cpu > 0.9 and env == "prod"' },
  { label: "No spaces", src: 'cpu>=0.9 and env=="prod eu"' },
  { label: "Open string", src: 'env == "prod\nand cpu > 0.9' },
  { label: "Comment", src: "errors / requests >= 0.05  # 5% failing\nand env != \"dev\"" },
  { label: "Bad character", src: "disk_used @ 90" },
];

export type Goal = "munch" | "broken" | "recover";
export const GOALS: { id: Goal; text: string }[] = [
  { id: "munch", text: "Watch the scanner take a two-character operator whole." },
  { id: "broken", text: "Break it: turn off longest match and scan a rule with >=." },
  { id: "recover", text: "Scan an open string and see scanning carry on past it." },
];

/* ---------------- state and step ---------------- */

export interface State {
  src: string;
  munch: boolean;
  /** Tokens revealed so far by stepping (0 = scanner not started). */
  shown: number;
  /** Total Step presses, to report the reader's own work. */
  steps: number;
  goals: Record<Goal, boolean>;
  /** Rules the reader has scanned to the end, as finishKey(src, munch). */
  finished: string[];
}

export type Action =
  | { type: "edit"; src: string }
  | { type: "preset"; index: number }
  | { type: "munch" }
  | { type: "step" }
  | { type: "run" }
  | { type: "back" }
  | { type: "reset" };

export function init(): State {
  return { src: PRESETS[1].src, munch: true, shown: 0, steps: 0, goals: { munch: false, broken: false, recover: false }, finished: [] };
}

export const finishKey = (src: string, munch: boolean) => (munch ? "" : "no-munch:") + src;

/** Update the challenge goals from the tokens the reader has now seen. */
function observe(st: State): State {
  const { tokens } = lex(st.src, { munch: st.munch });
  const seen = tokens.slice(0, st.shown);
  const g = { ...st.goals };
  if (st.munch && seen.some((t) => t.kind === "op" && t.text.length === 2)) g.munch = true;
  if (!st.munch && seen.some((t) => t.kind === "error" && t.text === "=") && /[<>]=/.test(st.src)) g.broken = true;
  const open = seen.findIndex((t) => t.message === "unterminated string");
  if (open >= 0 && seen.slice(open + 1).some((t) => t.kind !== "eof" && t.line > seen[open].line)) g.recover = true;
  const key = finishKey(st.src, st.munch);
  const finished = st.shown === tokens.length && !st.finished.includes(key) ? [...st.finished, key] : st.finished;
  return { ...st, goals: g, finished };
}

export function step(st: State, a: Action): State {
  const total = () => lex(st.src, { munch: st.munch }).tokens.length;
  switch (a.type) {
    case "reset":
      return init();
    case "edit":
      return { ...st, src: a.src, shown: 0 };
    case "preset":
      return { ...st, src: PRESETS[a.index].src, shown: 0 };
    case "munch":
      return observe({ ...st, munch: !st.munch, shown: Math.min(st.shown, lex(st.src, { munch: !st.munch }).tokens.length) });
    case "step":
      return st.shown >= total() ? st : observe({ ...st, shown: st.shown + 1, steps: st.steps + 1 });
    case "run":
      return observe({ ...st, shown: total() });
    case "back":
      return { ...st, shown: Math.max(0, st.shown - 1) };
  }
}

/** Where the scanner's two marks are after `shown` tokens: start of the last token, and current. */
export function cursor(st: State): { start: number; current: number } {
  const { tokens } = lex(st.src, { munch: st.munch });
  if (st.shown === 0) return { start: 0, current: 0 };
  const t = tokens[st.shown - 1];
  return { start: t.start, current: t.end };
}
