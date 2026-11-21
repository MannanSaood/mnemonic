"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import { GOALS, PRESETS, cursor, finishKey, init, lex, splitWords, step, type Kind, type Token } from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const KIND_LABEL: Record<Kind, string> = { ident: "name", keyword: "keyword", number: "number", string: "string", op: "op", error: "error", eof: "eof" };
const glyph = (c: string) => (c === " " ? "·" : c === "\n" ? "↵" : c === "\t" ? "→" : c);

type Guess = "4" | "7" | "9";

export default function LexingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const { tokens, reads, peeks } = lex(st.src, { munch: st.munch });
  const seen = tokens.slice(0, st.shown);
  const last: Token | null = seen[seen.length - 1] ?? null;
  const cur = cursor(st);
  const words = splitWords(st.src, tokens);
  const wrong = words.filter((w) => !w.ok).length;
  const done = st.shown === tokens.length;
  const seenPeeks = seen.reduce((s, t) => s + t.peeks, 0);
  const errors = seen.filter((t) => t.kind === "error");
  const revealed = st.finished.includes(finishKey(PRESETS[1].src, true));

  // Which revealed token covers each character, for colouring the source strip.
  const owner: (Token | null)[] = Array.from({ length: st.src.length }, () => null);
  for (const t of seen) for (let i = t.start; i < t.end; i++) owner[i] = t;

  return (
    <PgFrame title="Scan an alert rule into tokens" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question={`Splitting cpu>=0.9 and env=="prod eu" on spaces gives 4 words. How many tokens does a scanner emit before the end marker?`}
        options={[{ value: "4", label: "4" }, { value: "7", label: "7" }, { value: "9", label: "9" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="7"
        explain={<>cpu, &gt;=, 0.9, and, env, ==, &quot;prod eu&quot;. Spaces separate tokens only when they are there. The scanner decides where a token ends from the characters themselves: a digit cannot continue a name, &gt; followed by = is one operator, and a quote runs to the next quote, spaces and all.</>}
      />
      {!revealed && <p className="lexing-small muted">Scan the No spaces rule to the end (with longest match on) to check your answer.</p>}

      <div className="pg-card">
        <span className="label">The rule · pick one or type your own</span>
        <div className="pg-actions">
          {PRESETS.map((p, i) => (
            <button key={p.label} className={"pg-btn" + (st.src === p.src ? " primary" : "")} aria-pressed={st.src === p.src} onClick={() => dispatch({ type: "preset", index: i })}>{p.label}</button>
          ))}
        </div>
        <textarea className="lexing-input" rows={2} spellCheck={false} aria-label="Alert rule source"
          value={st.src} onChange={(e) => dispatch({ type: "edit", src: e.target.value })} />

        <div className="lexing-strip" aria-label="Source characters, coloured by the token that took them">
          {[...st.src].map((c, i) => {
            const t = owner[i];
            const mark = st.shown > 0 && i === cur.start ? " start" : "";
            const here = i === cur.current && !done ? " here" : "";
            return (
              <span key={i} className={"lexing-ch" + (t ? ` k-${t.kind}` : i < cur.current ? " skipped" : "") + mark + here + (c === "\n" ? " nl" : "")}>
                <b>{glyph(c)}</b><i>{i}</i>
              </span>
            );
          })}
          {done ? <span className="lexing-ch k-eof"><b>⊣</b><i>{st.src.length}</i></span> : st.src.length === cur.current && <span className="lexing-ch here"><b>⊣</b><i>{st.src.length}</i></span>}
        </div>
        <p className="lexing-small muted">Underline: where the last token started. Box: the next character the scanner will read. Grey: skipped.</p>

        <div className="pg-actions lexing-controls">
          <PgButton primary onClick={() => dispatch({ type: "step" })} disabled={done}>{st.shown === 0 ? "Start scanning" : "Next token"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "run" })} disabled={done}>Run to end</PgButton>
          <PgButton onClick={() => dispatch({ type: "back" })} disabled={st.shown === 0}>Back</PgButton>
          <PgChoice<"on" | "off"> label="Longest match" value={st.munch ? "on" : "off"}
            options={[{ value: "on", label: "Longest match on" }, { value: "off", label: "Off (break it)" }]}
            onChange={(v) => { if ((v === "on") !== st.munch) dispatch({ type: "munch" }); }} />
        </div>
        <p className={"lexing-why" + (last?.kind === "error" ? " bad" : "") + (reduced ? "" : " anim")} aria-live="polite" key={st.shown}>
          {last ? <><b>Scanner:</b> {last.skipped > 0 && `Skipped ${n(last.skipped, "character")}. `}{last.why}</> : "The scanner starts at character 0 with nothing read."}
        </p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Scanner · tokens so far</span>
          <ol className="lexing-tokens">
            {seen.map((t, i) => (
              <li key={i} className={`k-${t.kind}`}>
                <span className="lexing-kind">{KIND_LABEL[t.kind]}</span>
                <code>{t.kind === "eof" ? "⊣" : t.text.replace(/\n/g, "↵")}</code>
                <span className="lexing-pos">{t.line}:{t.col}{t.message ? ` · ${t.message}` : ""}</span>
              </li>
            ))}
            {seen.length === 0 && <li className="lexing-empty">Press Start scanning.</li>}
          </ol>
        </div>
        <div className="pg-card">
          <span className="label">rule.split() · words</span>
          <ol className="lexing-tokens">
            {words.map((w, i) => (
              <li key={i} className={w.ok ? "" : "k-error"}>
                <span className="lexing-kind">{w.ok ? "word" : "wrong"}</span>
                <code>{w.text}</code>
                <span className="lexing-pos">{w.ok ? "one token" : "not one token"}</span>
              </li>
            ))}
          </ol>
          <p className="lexing-small">{wrong === 0 ? "Every word happens to be one token: the rule was written with a space around everything." : `${n(wrong, "word")} of ${words.length} would reach the parser glued together or cut in half.`}</p>
        </div>
      </div>

      <dl className="pg-stats">
        <div><dt>Characters read</dt><dd>{cur.current} / {reads}</dd></div>
        <div><dt>Lookahead peeks</dt><dd>{seenPeeks}</dd></div>
        <div className={errors.length ? "bad" : ""}><dt>Tokens · errors</dt><dd>{seen.length} · {errors.length}</dd></div>
        <div className={wrong ? "bad" : ""}><dt>split() words wrong</dt><dd>{wrong} / {words.length}</dd></div>
      </dl>

      <div className="pg-req">
        <span className="label">Try these</span>
        <ul className="lexing-goals">
          {GOALS.map((g) => <li key={g.id} className={st.goals[g.id] ? "done" : ""}>{st.goals[g.id] ? "✓ " : "○ "}{g.text}</li>)}
        </ul>
      </div>

      {done && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your scan did</span>
          <p>
            Your rule has {n(reads, "character")}. The scanner read each one once, peeked ahead {n(peeks, "time")}, and emitted {n(tokens.length - 1, "token")} plus the end marker
            {errors.length ? <>, {n(errors.length, "error")} among them, each with a line and column ({errors.map((e) => `${e.line}:${e.col}`).join(", ")})</> : null}.
            {" "}Splitting on spaces gave {n(words.length, "word")}, {wrong} of them wrong.
            {!st.munch && <> With longest match off, every &gt;=, == and != fell apart into a lone character.</>}
          </p>
          <p className="pg-takeaway">
            A lexer decides where each token ends from the characters, not from spaces: one pass, one character of lookahead, always the longest match. Errors become tokens with positions, so one bad string does not hide the rest of the rule.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Crafting Interpreters, Scanning", href: "https://craftinginterpreters.com/scanning.html" },
        { title: "Rob Pike, Lexical Scanning in Go", href: "https://go.dev/talks/2011/lex.slide" },
        { title: "AST Explorer", href: "https://astexplorer.net/" },
      ]} />

      <style>{`
        .lexing-small { font-size: .88rem; margin: 0; }
        .lexing-small.muted, .lexing-why.muted { color: var(--ink-2); }
        .lexing-input { width: 100%; font-family: var(--f-code); font-size: .85rem; padding: 6px 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); resize: vertical; border-radius: 0; }
        .lexing-strip { display: flex; flex-wrap: wrap; gap: 2px 1px; padding: 6px; border: 1px solid var(--line); background: var(--bg); }
        .lexing-ch { display: inline-grid; justify-items: center; min-width: 1.35em; border: 1px solid transparent; border-bottom: 2px solid transparent; transition: background-color .15s; }
        .lexing-ch b { font-family: var(--f-code); font-weight: 500; font-size: .9rem; line-height: 1.5; color: var(--ink); }
        .lexing-ch i { font-style: normal; font-family: var(--f-code); font-size: .52rem; color: var(--ink-2); }
        .lexing-ch.nl { margin-right: 100%; }
        .lexing-ch.skipped b { color: var(--ink-2); opacity: .55; }
        .lexing-ch.start { border-bottom-color: var(--ink); }
        .lexing-ch.here { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
        .lexing-ch.k-ident, .lexing-tokens .k-ident .lexing-kind { background: var(--hl); }
        .lexing-ch.k-keyword, .lexing-tokens .k-keyword .lexing-kind { background: var(--surface-2); }
        .lexing-ch.k-keyword b { font-weight: 700; }
        .lexing-ch.k-number, .lexing-tokens .k-number .lexing-kind { background: var(--good-bg); }
        .lexing-ch.k-string, .lexing-tokens .k-string .lexing-kind { background: var(--surface-2); }
        .lexing-ch.k-string b { color: var(--shiki-token-string); }
        .lexing-ch.k-op, .lexing-tokens .k-op .lexing-kind { background: var(--hl); outline: 1px solid var(--accent); outline-offset: -1px; }
        .lexing-ch.k-error, .lexing-tokens .k-error .lexing-kind { background: var(--pain-bg); }
        .lexing-ch.k-error b { color: var(--pain); }
        .lexing-controls { align-items: center; }
        .lexing-why { margin: 0; font-size: .92rem; border-left: 3px solid var(--accent); padding: 4px 10px; background: var(--surface); }
        .lexing-why.bad { border-left-color: var(--pain); }
        .lexing-why.anim { animation: lexing-in .25s var(--ease); }
        @keyframes lexing-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
        .lexing-tokens { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; max-height: 260px; overflow: auto; }
        .lexing-tokens li { display: grid; grid-template-columns: 5.2em minmax(0, 1fr) auto; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--surface); padding: 2px 6px 2px 0; font-size: .8rem; }
        .lexing-tokens li.k-error { border-color: var(--pain); }
        .lexing-tokens code { font-size: .78rem; word-break: break-all; }
        .lexing-kind { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .05em; padding: 3px 6px; align-self: stretch; display: flex; align-items: center; }
        .lexing-pos { font-family: var(--f-code); font-size: .62rem; color: var(--ink-2); }
        .lexing-tokens li.k-error .lexing-pos { color: var(--pain); }
        .lexing-empty { color: var(--ink-2); font-size: .85rem; border: 1px dashed var(--line) !important; padding: 6px !important; display: block !important; }
        .lexing-goals { list-style: none !important; padding-left: 0 !important; }
        .lexing-goals li.done { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .lexing-ch { transition: none; } .lexing-why.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
