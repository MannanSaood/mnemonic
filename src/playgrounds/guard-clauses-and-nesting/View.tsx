"use client";
import { useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUGS, CHECK, PATHS, init, metrics, render, runTests, shown, step,
  type Action, type HelperId, type Line, type State, type Version,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function CodeLine({ l, i, st, dispatch }: { l: Line; i: number; st: State; dispatch: (a: Action) => void }) {
  const hunting = st.hunt.phase !== null;
  const editable = !hunting && (l.kind === "if" || l.kind === "guard");
  const helper = !hunting && l.check && (l.kind === "if" || l.kind === "guard") && CHECK[l.check].helper ? (l.check as HelperId) : null;
  const wrong = hunting && st.hunt.wrong === i;
  const cls = "gc-line k-" + l.kind + (wrong ? " wrong" : "");
  // Indent guides: one thin line per level, so the arrow shape of nested code is visible.
  const style = {
    paddingLeft: `calc(${l.depth * 2}ch + 6px)`,
    backgroundImage: l.depth > 0 ? "repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px 2ch)" : undefined,
    backgroundSize: `${l.depth * 2}ch 100%`, backgroundRepeat: "no-repeat", backgroundPosition: "6px 0",
  };
  const body = <code>{l.text || " "}</code>;
  return (
    <div className="gc-row">
      <span className="gc-num" aria-hidden="true">{i + 1}</span>
      {hunting ? (
        <button className={cls} style={style} onClick={() => dispatch({ type: "pick", line: i, at: Date.now() })} aria-label={`Line ${i + 1}: ${l.text}. Is the bug here?`}>{body}</button>
      ) : editable ? (
        <button className={cls + " edit"} style={style} onClick={() => dispatch({ type: "guard", id: l.check! })}
          aria-label={`${l.kind === "if" ? "Turn into a guard clause" : "Nest again"}: ${l.text}`}>
          {body}<span className="gc-hint">{l.kind === "if" ? "→ guard" : "→ nest"}</span>
        </button>
      ) : (
        <div className={cls} style={style}>{body}</div>
      )}
      {helper && (
        <button className={"gc-name" + (st.extracted[helper] ? " on" : "")} aria-pressed={st.extracted[helper]} onClick={() => dispatch({ type: "extract", id: helper })}>
          {st.extracted[helper] ? "inline" : "name it"}
        </button>
      )}
    </div>
  );
}

function Hunt({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const h = st.hunt;
  const v = h.phase;
  const start = (version: Version) => dispatch({ type: "hunt", version, at: Date.now() });
  if (v) {
    const failing = runTests(shown(st)).filter((r) => !r.ok);
    return (
      <div className="pg-card gc-hunt">
        <span className="label">Bug hunt · {v} version</span>
        <p>A bug is planted in the code above. The tests say:</p>
        <ul>{failing.map((r) => <li key={r.test.name}><b>{r.test.name}</b>: expected {r.test.expect}, got {r.got}</li>)}</ul>
        <p className="pg-rule"><b>Click the line that causes it.</b> {h.clicks > 0 ? `${n(h.clicks, "click")} so far.` : "The clock is running."}</p>
      </div>
    );
  }
  return (
    <div className="pg-card gc-hunt">
      <span className="label">Bug hunt</span>
      <p>The same kind of bug (two failure replies swapped) is planted in each version. Find it in both and compare.</p>
      <div className="pg-actions">
        <PgButton primary={!h.nested} onClick={() => start("nested")}>{h.nested ? "Hunt the nested version again" : "Hunt in the nested version"}</PgButton>
        <PgButton primary={!!h.nested && !h.flat} onClick={() => start("flat")}>{h.flat ? "Hunt the flat version again" : "Hunt in the flat version"}</PgButton>
      </div>
      {(h.nested || h.flat) && (
        <dl className="pg-stats">
          <div><dt>Nested</dt><dd>{h.nested ? `${secs(h.nested.ms)} · ${n(h.nested.clicks, "click")}` : "not yet"}</dd></div>
          <div><dt>Flat</dt><dd>{h.flat ? `${secs(h.flat.ms)} · ${n(h.flat.clicks, "click")}` : "not yet"}</dd></div>
        </dl>
      )}
    </div>
  );
}

export default function GuardClausesPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<"1" | "7" | "13" | null>(null);
  const shape = shown(st);
  const lines = render(shape);
  const m = metrics(shape);
  const start = metrics(init());
  const tests = runTests(shape);
  const red = tests.filter((t) => !t.ok);
  const flat = !st.hunt.phase && m.depth === 0;
  const h = st.hunt;

  return (
    <PgFrame title="Flatten the webhook handler" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict<"1" | "7" | "13">
        question="The handler has six checks nested inside each other. Once every check is a guard clause, how many paths run through it?"
        options={[{ value: "1", label: "1" }, { value: "7", label: "7" }, { value: "13", label: "13" }]}
        value={guess}
        onChange={setGuess}
        revealed={flat}
        answer="7"
        explain={<>Still {PATHS}: six ways to fail and one way to succeed, before and after. Guard clauses do not remove decisions. They change how many you have to keep in mind at once: depth went from {start.depth} to 0 and cognitive complexity from {start.cognitive} to {m.cognitive}.</>}
      />

      <p className="pg-rule">{st.hunt.phase ? <b>Hunting: click the line with the bug.</b> : <><b>Click an <code>if</code> to turn it into a guard clause.</b> Click &quot;name it&quot; to move a long condition into a named function. The tests run after every step.</>}</p>

      <div className="gc-main">
        <div className="gc-code" aria-live="polite">
          {lines.map((l, i) => <CodeLine key={`${st.hunt.phase ?? "edit"}-${i}-${l.text}`} l={l} i={i} st={st} dispatch={dispatch} />)}
        </div>
        <div className="gc-side">
          <dl className="pg-stats gc-stats">
            <div className={m.depth > 2 ? "bad" : ""}><dt>Nesting depth</dt><dd>{m.depth}</dd></div>
            <div className={m.cognitive > 15 ? "bad" : ""}><dt>Cognitive complexity</dt><dd>{m.cognitive}{m.helpers ? <small> +{m.helpers} in helpers</small> : null}</dd></div>
            <div className={m.openAtMain > 2 ? "bad" : ""}><dt>Open branches at main line</dt><dd>{m.openAtMain}</dd></div>
            <div className={m.farthest > 10 ? "bad" : ""}><dt>Farthest if → its reply</dt><dd>{m.farthest ? `${m.farthest} lines` : "same line"}</dd></div>
            <div><dt>Paths</dt><dd>{m.paths}</dd></div>
          </dl>
          <div className={"gc-tests" + (red.length ? " red" : "")}>
            <span className="label">Tests {tests.length - red.length}/{tests.length}</span>
            <div className="gc-dots">{tests.map((t) => <span key={t.test.name} className={t.ok ? "ok" : "no"} title={`${t.test.name}: expected ${t.test.expect}, got ${t.got}`}>{t.ok ? "■" : "✗"}</span>)}</div>
            {red.map((t) => <p key={t.test.name} className="gc-fail">{t.test.name}: expected {t.test.expect}, got {t.got}</p>)}
          </div>
          {!st.hunt.phase && (
            <div className="pg-actions">
              <PgButton onClick={() => dispatch({ type: "flattenAll" })}>Flatten all</PgButton>
              <button className={"pg-btn" + (st.sigFirst ? " primary" : "")} aria-pressed={st.sigFirst} onClick={() => dispatch({ type: "swap" })}
                title="Move the signature check above the method check">Break it: check signature first</button>
            </div>
          )}
        </div>
      </div>

      <Hunt st={st} dispatch={dispatch} />

      {(st.steps.length > 0 || h.nested || h.flat) && (
        <div className="pg-result">
          <span className="label">What your refactoring changed</span>
          <p className="pg-takeaway">
            {st.steps.length > 0 && <>In {n(st.steps.length, "step")} you took the handler from depth {start.depth} and complexity {start.cognitive} to depth {metrics(st).depth} and complexity {metrics(st).cognitive}. Paths stayed at {PATHS}{st.redRuns === 0 ? ", and every test passed after every step: the code reads differently and behaves the same." : `. The tests went red ${n(st.redRuns, "time")}: moving a guard changes which reply wins when a request fails two checks. Order is behaviour.`} </>}
            {h.nested && h.flat ? <>You found the swapped replies in {secs(h.nested.ms)} ({n(h.nested.clicks, "click")}) in the nested version and {secs(h.flat.ms)} ({n(h.flat.clicks, "click")}) in the flat one. {h.flat.ms < h.nested.ms ? "In the flat version each check and its reply sit on one line, so a wrong reply is visible where it happens." : "You were quicker in the nested version this time; the second hunt is easier once you know the kind of bug. Look at the farthest-distance number: in the nested version you had to match an else to an if " + start.farthest + " lines up."}</>
              : h.nested ? <>Nested hunt: {secs(h.nested.ms)}, {n(h.nested.clicks, "click")}. Now try the flat version.</> : null}
          </p>
        </div>
      )}

      <p className="muted gc-note">Planted bugs: nested swaps the replies of {CHECK[BUGS.nested[0]].label} and {CHECK[BUGS.nested[1]].label}; flat swaps {CHECK[BUGS.flat[0]].label} and {CHECK[BUGS.flat[1]].label}. Cognitive complexity follows SonarSource&apos;s rules: +1 per if plus 1 per enclosing if, +1 per else, +1 per run of &amp;&amp; or ||.</p>

      <PgSources links={[
        { title: "Jeff Atwood, Flattening Arrow Code", href: "https://blog.codinghorror.com/flattening-arrow-code/" },
        { title: "refactoring.com, Replace Nested Conditional with Guard Clauses", href: "https://refactoring.com/catalog/replaceNestedConditionalWithGuardClauses.html" },
        { title: "G. Ann Campbell, Cognitive Complexity (SonarSource)", href: "https://www.sonarsource.com/docs/CognitiveComplexity.pdf" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.gc-main { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 10px; align-items: start; }
.gc-code { border: 1px solid var(--line); background: var(--surface); padding: 6px 0; overflow-x: auto; }
.gc-row { display: flex; align-items: stretch; min-width: max-content; }
.gc-num { width: 3ch; flex: none; text-align: right; padding-right: 6px; font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); user-select: none; line-height: 1.6; }
.gc-line { flex: 1; display: flex; gap: 8px; align-items: center; border: 0; background-color: transparent; text-align: left; padding: 0 8px 0 6px; font-family: var(--f-code); font-size: .74rem; color: var(--ink); line-height: 1.6; white-space: pre; }
.gc-line code { background: none; padding: 0; font-size: inherit; }
button.gc-line { cursor: pointer; }
button.gc-line:hover, button.gc-line:focus-visible { background-color: var(--hl); }
.gc-line.k-guard code { color: var(--good); }
.gc-line.k-else code, .gc-line.k-close code { color: var(--ink-2); }
.gc-line.k-return code { color: var(--pain); }
.gc-line.k-body code { font-weight: 700; }
.gc-line.wrong { background-color: var(--pain-bg); }
.gc-hint { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--accent); opacity: 0; }
button.gc-line:hover .gc-hint, button.gc-line:focus-visible .gc-hint { opacity: 1; }
.gc-name { flex: none; margin: 1px 6px; border: 1px solid var(--accent); background: var(--surface); color: var(--accent); font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; padding: 0 5px; }
.gc-name.on { background: var(--accent); color: var(--accent-ink); }
.gc-side { display: grid; gap: 8px; }
.gc-stats { grid-template-columns: 1fr 1fr; }
.gc-stats small { display: block; font-size: .62rem; font-weight: 400; color: var(--ink-2); }
.gc-tests { border: 1px solid var(--good); background: var(--good-bg); padding: 6px 8px; }
.gc-tests.red { border-color: var(--pain); background: var(--pain-bg); }
.gc-dots { display: flex; gap: 3px; font-size: .8rem; }
.gc-dots .ok { color: var(--good); }
.gc-dots .no { color: var(--pain); }
.gc-fail { margin: 2px 0 0; font-size: .8rem; color: var(--pain); }
.gc-hunt ul { margin: 0; padding-left: 1.2em; }
.gc-hunt p { margin: 0; }
.gc-note { font-size: .8rem; margin: 0; }
@media (max-width: 760px) { .gc-main { grid-template-columns: 1fr; } }
`;
