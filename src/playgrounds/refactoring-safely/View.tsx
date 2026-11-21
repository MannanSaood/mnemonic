"use client";
import { useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  PLAN, SLIP_STEP, bigBang, changedLines, code, done, greenCode, init, runSuite, smallSteps, step,
  type Event, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
type Guess = "rename" | "shipping" | "move";

function Plan({ st }: { st: State }) {
  return (
    <ol className="rf-plan">
      {PLAN.map((p) => {
        const state = p.id <= st.lastGreen ? "green" : p.id <= st.applied ? "untested" : p.id === st.applied + 1 ? "next" : "todo";
        const suspect = st.lastRun && !st.lastRun.green && st.lastRun.suspects.includes(p.id);
        return (
          <li key={p.id} className={`rf-step ${state}` + (suspect ? " suspect" : "")}>
            <span className="rf-mark" aria-hidden="true">{state === "green" ? "■" : state === "untested" ? "◧" : "□"}</span>
            <span>
              <b>{p.id}. {p.move}</b> <small className="rf-cat">{p.catalogue}</small>
              <br /><small>{p.what}</small>
              {suspect && <><br /><small className="rf-sus">suspect: changed since the last green run</small></>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Code({ st }: { st: State }) {
  const now = code(st);
  const green = new Set(greenCode(st));
  return (
    <pre className="rf-code" aria-label="Current source">
      {now.map((l, i) => {
        const changed = l.trim() !== "" && !green.has(l);
        return <div key={`${i}-${l}`} className={"rf-ln" + (changed ? " changed" : "")}><span className="rf-num" aria-hidden="true">{i + 1}</span>{l || " "}</div>;
      })}
    </pre>
  );
}

function History({ log }: { log: Event[] }) {
  if (!log.length) return null;
  return (
    <div className="rf-hist" aria-label="History">
      {log.map((e, i) => {
        if (e.kind === "apply") return <span key={i} className="rf-chip">{e.steps.length === 1 ? `step ${e.steps[0]}` : `steps ${e.steps[0]}-${e.steps[e.steps.length - 1]}`}</span>;
        if (e.kind === "test") return <span key={i} className={"rf-chip " + (e.run.green ? "ok" : "no")}>{e.run.green ? "tests ✓" : "tests ✗"}</span>;
        return <span key={i} className="rf-chip rv">revert −{e.discarded}</span>;
      })}
    </div>
  );
}

export default function RefactoringPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const results = runSuite(st.applied, st.slip);
  const sinceGreen = st.applied - st.lastGreen;
  const changed = changedLines(greenCode(st), code(st));
  const sawRed = st.reds > 0;
  const next = PLAN[st.applied];
  const last = st.lastRun;
  const big = bigBang();
  const small = smallSteps();
  const firstRed = st.log.find((e) => e.kind === "test" && !e.run.green);
  const yourRed = firstRed && firstRed.kind === "test" ? firstRed.run : null;

  return (
    <PgFrame title="Refactor a legacy function, step by step" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict<Guess>
        question="One step of this six-step plan changes what the function returns, by accident. Which one?"
        options={[
          { value: "rename", label: "1. Rename" },
          { value: "shipping", label: "4. Extract shippingFee" },
          { value: "move", label: "6. Move the discount" },
        ]}
        value={guess}
        onChange={setGuess}
        revealed={sawRed}
        answer="shipping"
        explain={<>The extracted <code>shippingFee</code> says <code>subtotal &lt;= FREE_SHIPPING_FROM</code>; the original said <code>t &lt; 50</code>. An order of exactly 50.00 now pays 4.99. It reads as the same rule, and only the boundary test notices. How quickly you could tell which step did it depended on how many steps you took since the last green run.</>}
      />

      <p className="pg-rule"><b>Apply the plan one step at a time and run the tests when you choose.</b> A green run commits. A red run lists the suspects: every step since the last green. Or rewrite it all at once and compare.</p>

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "apply" })} disabled={!next}>{next ? `Apply step ${next.id}: ${next.move}` : "Plan complete"}</PgButton>
        <PgButton primary={sinceGreen > 0} onClick={() => dispatch({ type: "test" })}>Run tests</PgButton>
        <PgButton onClick={() => dispatch({ type: "revert" })} disabled={sinceGreen === 0}>Revert to last green{sinceGreen ? ` (−${n(sinceGreen, "step")})` : ""}</PgButton>
        <PgButton onClick={() => dispatch({ type: "rewrite" })} disabled={!next} title="Apply every remaining step at once, then test">Big rewrite: all remaining at once</PgButton>
      </div>

      <div className="rf-main">
        <div className="rf-left">
          <Plan st={st} />
          <div className={"rf-tests" + (last && !last.green ? " red" : last?.green ? " green" : "")} aria-live="polite">
            <span className="label">{last ? (last.green ? "Tests passed · committed" : "Tests failed") : sinceGreen ? "Tests not run since your last change" : "Tests: green at the last commit"}</span>
            {last && results.map((r) => (
              <p key={r.name} className={r.ok ? "rf-ok" : "rf-no"}>{r.ok ? "✓" : "✗"} {r.name}{r.ok ? "" : `: expected ${r.expect.toFixed(2)}, got ${r.got.toFixed(2)}`}</p>
            ))}
            {last && !last.green && (
              <p className="rf-where"><b>{last.suspects.length === 1 ? `The change is in step ${last.suspects[0]}.` : `The change is in one of steps ${last.suspects.join(", ")}.`}</b> {n(last.changed, "changed line")} to read through.{last.suspects.length === 1 && last.suspects[0] === SLIP_STEP ? " Revert it and apply it again; you know where to look now." : ""}</p>
            )}
          </div>
        </div>
        <div className="rf-right">
          <span className="label">orders.ts · {sinceGreen ? `${n(changed, "line")} changed since the last green run` : "matches the last green commit"}</span>
          <Code st={st} />
        </div>
      </div>

      <dl className="pg-stats">
        <div><dt>Steps applied</dt><dd>{st.stepsApplied}</dd></div>
        <div><dt>Test runs</dt><dd>{st.runs}</dd></div>
        <div className={st.reds ? "bad" : ""}><dt>Red runs</dt><dd>{st.reds}</dd></div>
        <div className={sinceGreen > 1 ? "bad" : ""}><dt>Untested steps</dt><dd>{sinceGreen}</dd></div>
        <div className={st.discarded ? "bad" : ""}><dt>Steps thrown away</dt><dd>{st.discarded}</dd></div>
      </dl>

      <History log={st.log} />

      {(sawRed || done(st)) && (
        <div className="pg-result">
          <span className="label">What your session cost, against the two extremes</span>
          <table className="rf-table">
            <thead><tr><th></th><th>Test runs</th><th>Suspects at the first red</th><th>Lines to read</th></tr></thead>
            <tbody>
              <tr><td>You</td><td>{st.runs}</td><td>{yourRed ? n(yourRed.suspects.length, "step") : "none yet"}</td><td>{yourRed ? yourRed.changed : "–"}</td></tr>
              <tr><td>One big rewrite</td><td>{big.runs} then hunting</td><td>{n(big.suspects, "step")}</td><td>{big.changed}</td></tr>
              <tr><td>Test after every step</td><td>{small.runs}</td><td>{n(small.suspects, "step")}</td><td>{small.changed}</td></tr>
            </tbody>
          </table>
          <p className="pg-takeaway">
            {yourRed
              ? yourRed.suspects.length === 1
                ? `Your tests went red one step after the slip, so the suspect was a single ${n(yourRed.changed, "changed line")} diff. `
                : `Your first red run came ${n(yourRed.suspects.length, "step")} after the last green one, so the slip hid among ${n(yourRed.changed, "changed line")}. `
              : ""}
            {done(st) ? `You finished the plan with ${n(st.runs, "test run")} and threw away ${n(st.discarded, "step")}. ` : ""}
            A test run costs seconds. A red run after one small step tells you where the change is; after a rewrite it only tells you that there is one.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Martin Fowler, refactoring.com catalogue", href: "https://refactoring.com/catalog/" },
        { title: "Emily Bache, Gilded Rose refactoring kata", href: "https://github.com/emilybache/GildedRose-Refactoring-Kata" },
        { title: "Kent Beck, Tidy First?", href: "https://tidyfirst.substack.com/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.rf-main { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 10px; align-items: start; }
.rf-left { display: grid; gap: 8px; }
.rf-plan { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.rf-step { display: flex; gap: 8px; border: 1px solid var(--line); background: var(--surface); padding: 5px 8px; font-size: .88rem; }
.rf-step small { color: var(--ink-2); }
.rf-cat { font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .05em; }
.rf-step.green { border-left: 4px solid var(--good); }
.rf-step.untested { border-left: 4px solid var(--accent); background: var(--hl); }
.rf-step.next { border-style: dashed; }
.rf-step.todo { opacity: .7; }
.rf-step.suspect { border-color: var(--pain); background: var(--pain-bg); }
.rf-mark { font-size: .8rem; }
.rf-step.green .rf-mark { color: var(--good); }
.rf-sus { color: var(--pain) !important; }
.rf-tests { border: 1px solid var(--line); padding: 6px 8px; background: var(--surface); }
.rf-tests.green { border-color: var(--good); background: var(--good-bg); }
.rf-tests.red { border-color: var(--pain); background: var(--pain-bg); }
.rf-tests p { margin: 2px 0 0; font-size: .82rem; }
.rf-ok { color: var(--good); }
.rf-no { color: var(--pain); font-weight: 700; }
.rf-where { color: var(--ink); }
.rf-right { min-width: 0; display: grid; gap: 4px; }
.rf-code { margin: 0; border: 1px solid var(--line); background: var(--surface); padding: 6px 0; overflow-x: auto; font-size: .72rem; line-height: 1.55; }
.rf-ln { padding: 0 8px 0 0; white-space: pre; transition: background-color .25s var(--ease); }
.rf-ln.changed { background: var(--hl); box-shadow: inset 3px 0 0 var(--accent); }
.rf-num { display: inline-block; width: 3.5ch; text-align: right; margin-right: 1.5ch; color: var(--ink-2); user-select: none; }
.rf-hist { display: flex; flex-wrap: wrap; gap: 4px; }
.rf-chip { font-family: var(--f-code); font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; border: 1px solid var(--line); padding: 1px 6px; background: var(--surface); }
.rf-chip.ok { border-color: var(--good); color: var(--good); }
.rf-chip.no { border-color: var(--pain); color: var(--pain); }
.rf-chip.rv { border-style: dashed; }
.rf-table { border-collapse: collapse; width: 100%; font-size: .88rem; }
.rf-table th, .rf-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; }
.rf-table th { font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
@media (max-width: 760px) { .rf-main { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .rf-ln { transition: none; } }
`;
