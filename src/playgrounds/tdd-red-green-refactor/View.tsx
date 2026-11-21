"use client";
import { usePrefs } from "@/components/Prefs";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  PREDICT_ANSWER, TESTS, TEST_IDS, challenges, codeLines, greenMoves, init, itemsText, money, predictRevealed, refactorMoves, runTest, step, summary, untestedLines,
  type Action, type Move, type Phase, type Predict, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const FN = { go: "CartTotal", python: "cart_total", typescript: "cartTotal", rust: "cart_total" } as const;
const SIZE: Record<Move["size"], string> = { small: "small step", medium: "medium step", big: "big step", risky: "tidy-up" };

function Loop({ phase }: { phase: Phase }) {
  const on = (p: "red" | "green" | "refactor") =>
    (p === "red" && (phase === "red" || phase === "broken")) || (p === "green" && phase === "pick") || (p === "refactor" && phase === "refactor");
  return (
    <ol className="tdd-loop" aria-label="Where you are in the cycle">
      <li className={"r" + (on("red") ? " on" : "")}>Red<small>{phase === "broken" ? "unexpected" : "a failing test"}</small></li>
      <li className={"g" + (on("refactor") ? " on" : "")}>Green<small>smallest change</small></li>
      <li className={"f" + (on("refactor") ? " on" : "")}>Refactor<small>tests stay green</small></li>
      <li className={"p" + (on("green") ? " on" : "")}>Next test<small>from the list</small></li>
    </ol>
  );
}

function Bars({ st }: { st: State }) {
  return (
    <div className="tdd-bars" aria-label={`Test runs so far: ${st.bars.length}`}>
      <span className="label">Every run of the suite</span>
      <div className="tdd-strip">
        {st.bars.length === 0 && <span className="muted">No runs yet.</span>}
        {st.bars.map((b, i) => <i key={i} className={b.kind} title={b.label} />)}
      </div>
    </div>
  );
}

function Tests({ st, dispatch, fn }: { st: State; dispatch: (a: Action) => void; fn: string }) {
  return (
    <div className="pg-card">
      <span className="label">Test list · {st.written.length} of {TEST_IDS.length} written</span>
      <ol className="tdd-tests">
        {TEST_IDS.map((id) => {
          const t = TESTS[id];
          const written = st.written.includes(id);
          const r = written ? runTest(st.impl, id) : null;
          return (
            <li key={id} className={written ? (r!.pass ? "pass" : "fail") : "todo"}>
              <div>
                <b>{written ? (r!.pass ? "✓ " : "✗ ") : "○ "}{t.name}</b>
                <code>{fn}({itemsText(t)}) == {money(t.want)}</code>
                {r && !r.pass && <span className="tdd-why">{r.message}</span>}
                {st.neverRed.includes(id) && <span className="tdd-why soft">never seen red</span>}
              </div>
              {!written && st.phase === "pick" && <PgButton onClick={() => dispatch({ type: "write", test: id })}>Write it</PgButton>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Code({ st }: { st: State }) {
  const { lang } = usePrefs();
  const now = codeLines(st.impl, lang);
  const before = st.prev ? codeLines(st.prev, lang) : now;
  const pool = [...before];
  const fresh = now.map((l) => { const k = pool.indexOf(l); if (k >= 0) { pool.splice(k, 1); return false; } return l.trim() !== ""; });
  return (
    <div className="pg-card">
      <span className="label">The code · {untestedLines(st.impl, st.written) ? `${n(untestedLines(st.impl, st.written), "line")} no test asks for` : "every line asked for by a test"}</span>
      <div className="pgc tdd-code">
        {now.map((l, i) => (
          <div key={i} className={"pgc-line" + (fresh[i] && st.lastLines ? (st.phase === "broken" ? " bad" : " new") : "")}><code>{l || " "}</code></div>
        ))}
      </div>
    </div>
  );
}

function Moves({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  if (st.phase === "pick") return <p className="muted">Pick the next test from the list. Which one would teach the code the smallest new thing?</p>;
  if (st.phase === "done") return null;
  if (st.phase === "broken") return <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "undo" })}>Undo the last change</PgButton></div>;
  const red = st.phase === "red";
  const moves = red && st.current ? greenMoves(st.impl, st.current) : refactorMoves(st.impl);
  return (
    <div className="tdd-moves">
      <span className="label">{red ? "Make it green: pick a change" : "Refactor while green, or move on"}</span>
      {moves.map((m) => (
        <button key={m.id} className={"tdd-move " + m.size} onClick={() => dispatch(red ? { type: "green", move: m.id } : { type: "refactor", move: m.id })}>
          <span>{m.label}</span>
          <small>{SIZE[m.size]} · {n(m.lines, "line")}</small>
        </button>
      ))}
      {!red && <PgButton primary onClick={() => dispatch({ type: "doneRefactoring" })}>{st.written.length === TEST_IDS.length ? "Finish" : "Done: write the next test"}</PgButton>}
    </div>
  );
}

function Result({ st }: { st: State }) {
  const s = summary(st);
  if (s.written < 3) return null;
  const done = st.phase === "done";
  let take: string;
  if (s.surprises === 0 && s.neverRed === 0 && s.largestStep <= 5)
    take = "Small steps, each one asked for by a red test. When every step is that small, a red bar is never a mystery: it can only be the last few lines.";
  else if (s.surprises > 0)
    take = "Each surprise red came from a step that did more than the test asked, or did it slightly wrong. Smaller steps make the cause of a red bar obvious.";
  else if (s.neverRed > 0)
    take = "Some tests never went red because the code was already there. You wrote code before a test asked for it, so for a while it had no test at all.";
  else take = "Keep the steps as small as the test needs, and refactor only while green.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">{done ? "Your run through the list" : "Your run so far"}</span>
      <p>
        {n(s.written, "test")} written, {n(s.cycles, "red-to-green cycle")}. Largest step: {n(s.largestStep, "line")}.
        Surprise red bars: {s.surprises}. Tests you never saw fail: {s.neverRed}. Refactorings the tests caught: {s.slipsCaught}.
      </p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function TddPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const s = summary(st);

  return (
    <PgFrame title="Drive a cart total test-first" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The job</span>
        <p>Build <code>{FN[lang]}(items, coupon)</code> in cents: the sum of price × quantity; 10% off when the subtotal is $100.00 or more; the <code>SAVE5</code> coupon takes $5.00 off after that; never below $0.00.</p>
        <p className="pg-rule"><b>Write one test from the list. See it fail. Make it pass with the smallest change. Clean up while green. Repeat.</b></p>
      </div>

      <PgPredict<Predict>
        question="You have just written a new test, and no code for it yet. What should the bar show when you run the suite?"
        options={[{ value: "green", label: "Green" }, { value: "red", label: "Red" }, { value: "either", label: "Either is fine" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Red. A new test that fails proves two things: the test can fail, and the behaviour is not there yet. A test that passes at once tells you nothing new, and may not test what you think. Take a big step early on and you will see that happen later in the list.</>}
      />

      <Loop phase={st.phase} />
      <Bars st={st} />

      <p className={"tdd-note " + st.phase} aria-live="polite">{st.note}</p>
      <Moves st={st} dispatch={dispatch} />

      <div className="pg-grid">
        <Tests st={st} dispatch={dispatch} fn={FN[lang]} />
        <Code st={st} />
      </div>

      <dl className="pg-stats">
        <div><dt>Red → green cycles</dt><dd>{s.cycles}</dd></div>
        <div className={s.largestStep > 5 ? "bad" : ""}><dt>Largest step</dt><dd>{n(s.largestStep, "line")}</dd></div>
        <div className={s.surprises ? "bad" : ""}><dt>Surprise reds</dt><dd>{s.surprises}</dd></div>
        <div className={s.neverRed || s.untested ? "bad" : ""}><dt>Never red · untested</dt><dd>{s.neverRed} · {n(s.untested, "line")}</dd></div>
      </dl>

      <Result st={st} />

      <div className="tdd-challenges">
        <span className="label">Challenges</span>
        <ul>{challenges(st).map((c) => <li key={c.id} className={c.done ? "done" : ""}>{c.done ? "✓ " : "○ "}{c.text}</li>)}</ul>
      </div>

      <PgSources links={[
        { title: "Kent Beck: Canon TDD", href: "https://newsletter.kentbeck.com/p/canon-tdd" },
        { title: "Martin Fowler: Test Driven Development", href: "https://martinfowler.com/bliki/TestDrivenDevelopment.html" },
        { title: "Robert C. Martin: The Cycles of TDD", href: "https://blog.cleancoder.com/uncle-bob/2014/12/17/TheCyclesOfTDD.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.tdd-loop { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.tdd-loop li { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; font-family: var(--f-code); font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; display: grid; gap: 2px; color: var(--ink-2); transition: background .2s var(--ease), color .2s var(--ease); }
.tdd-loop li small { text-transform: none; letter-spacing: 0; font-size: .72rem; }
.tdd-loop li.r.on { background: var(--pain-bg); color: var(--pain); border-color: var(--pain); }
.tdd-loop li.g.on, .tdd-loop li.f.on { background: var(--good-bg); color: var(--good); border-color: var(--good); }
.tdd-loop li.p.on { background: var(--hl); color: var(--accent); border-color: var(--accent); }
.tdd-bars { display: grid; gap: 4px; }
.tdd-strip { display: flex; flex-wrap: wrap; gap: 3px; min-height: 18px; align-items: center; }
.tdd-strip i { width: 14px; height: 18px; display: block; border: 1px solid var(--line); }
.tdd-strip i.green { background: var(--good); border-color: var(--good); }
.tdd-strip i.red { background: var(--pain); border-color: var(--pain); }
.tdd-strip i.surprise { background: var(--pain-bg); border: 2px solid var(--pain); }
.tdd-strip i.caught { background: var(--bg); border: 2px dashed var(--pain); }
.tdd-note { margin: 0; border-left: 3px solid var(--accent); padding: 4px 10px; background: var(--surface); }
.tdd-note.red, .tdd-note.broken { border-left-color: var(--pain); }
.tdd-note.refactor, .tdd-note.done { border-left-color: var(--good); }
.tdd-moves { display: grid; gap: 4px; justify-items: stretch; }
.tdd-moves .pg-btn { justify-self: start; }
.tdd-move { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 6px 10px; color: var(--ink); font-size: .92rem; }
.tdd-move small { font-family: var(--f-code); font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-2); white-space: nowrap; }
.tdd-move.big small, .tdd-move.risky small { color: var(--pain); }
.tdd-move:hover { border-color: var(--accent); }
.tdd-tests { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.tdd-tests li { display: flex; justify-content: space-between; gap: 8px; align-items: center; border-left: 3px solid var(--line); background: var(--surface); padding: 4px 8px; }
.tdd-tests li > div { display: grid; gap: 1px; min-width: 0; font-size: .88rem; }
.tdd-tests li.pass { border-left-color: var(--good); }
.tdd-tests li.fail { border-left-color: var(--pain); background: var(--pain-bg); }
.tdd-tests code { font-size: .68rem; word-break: break-word; }
.tdd-why { font-size: .8rem; color: var(--pain); }
.tdd-why.soft { color: var(--ink-2); font-style: italic; }
.tdd-code code { white-space: pre; font-size: .72rem; }
.tdd-code { overflow-x: auto; }
.tdd-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.tdd-challenges li.done { color: var(--good); }
@media (max-width: 760px) { .tdd-loop { grid-template-columns: 1fr 1fr; } }
@media (prefers-reduced-motion: reduce) { .tdd-loop li { transition: none; } }
`;
