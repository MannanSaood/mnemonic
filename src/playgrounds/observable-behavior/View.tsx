"use client";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BLOCKS, BUGS, CHANGES, PREDICT_ANSWER, REFACTORS, TESTS, activeTests, challenges, init, outcome, predictRevealed, runAll, score, step,
  type Action, type Block, type BugId, type ChangeId, type RefactorId, type Predict, type State, type SuiteId, type TestResult,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function BlockCard({ b, st, dispatch }: { b: Block; st: State; dispatch: (a: Action) => void }) {
  const touching = activeTests(st).filter((t) => t.touches.includes(b.id));
  const changed = st.active && CHANGES[st.active].block === b.id;
  const btn = (c: ChangeId) => {
    const on = st.active === c;
    const kind = CHANGES[c].kind;
    return (
      <button key={c} className={"ob-act " + kind + (on ? " on" : "")} aria-pressed={on} title={CHANGES[c].what}
        onClick={() => dispatch({ type: "apply", change: c })}>
        {on ? "Undo: " : kind === "refactor" ? "Refactor: " : "Plant bug: "}{CHANGES[c].title}
        {st.tried.includes(c) && !on ? " ✓" : ""}
      </button>
    );
  };
  return (
    <div className={"ob-block" + (b.observable ? " obs" : " impl") + (changed ? " changed" : "")}>
      <code className="ob-name">{b.name}</code>
      <span className="muted">{b.what}</span>
      <span className="ob-touch" aria-label={`Tests that name ${b.name}`}>
        {touching.length === 0 ? <i className="muted">no test names it</i> : touching.map((t) => (
          <code key={t.id} className={"ob-chip " + t.suite}>{t.id.toUpperCase()}</code>
        ))}
      </span>
      {(b.refactor || b.bug) && (
        <div className="ob-acts">
          {b.refactor && btn(b.refactor)}
          {b.bug && btn(b.bug)}
        </div>
      )}
    </div>
  );
}

function Suite({ suite, results, st, dispatch }: { suite: SuiteId; results: TestResult[]; st: State; dispatch: (a: Action) => void }) {
  const o = outcome(results, suite);
  const bug = st.active && CHANGES[st.active].kind === "bug";
  const rs = results.filter((r) => r.test.suite === suite);
  return (
    <section className="pg-side" aria-label={suite === "A" ? "Suite A, through internals" : "Suite B, through observable behaviour"}>
      <header>
        <h4>{suite === "A" ? "Suite A · internals" : "Suite B · behaviour"}</h4>
        <span className={"pg-status" + (o.red ? "" : " done")}>{o.red ? `red · ${n(o.failing, "failing test")}` : "green"}</span>
      </header>
      <p className="muted">{suite === "A" ? "Mocks the calculator and the reserver, spies on the order's setters, calls the private helper." : "Real order, real stock in memory, a spy only on the courier, which leaves the system."}</p>
      <ol className="ob-tests">
        {rs.map((r) => (
          <li key={r.test.id} className={r.red ? "red" : "green"}>
            <span className="ob-tid">{r.test.id.toUpperCase()}</span>
            <div>
              <b>{r.red ? "✗ " : "✓ "}{r.test.name}</b>
              <code>{r.test.code}</code>
              {st.active && (r.red || (bug && r.test.blind?.[st.active as BugId])) && <span className={r.red ? "ob-why" : "ob-why blind"}>{r.reason}</span>}
            </div>
          </li>
        ))}
      </ol>
      {suite === "B" && (
        <PgButton onClick={() => dispatch({ type: "iceland", on: !st.iceland })}>
          {st.iceland ? "Remove the Iceland test" : "Add a test: an Iceland order ships from Reykjavik"}
        </PgButton>
      )}
    </section>
  );
}

function Result({ st }: { st: State }) {
  const s = score(st);
  if (!s.refactors && !s.bugs) return null;
  let take: string;
  if (s.refactors && s.bugs >= 2)
    take = s.misses.B === 0
      ? "Suite B never cried wolf and missed nothing. Its tests name only what a caller can see, so refactorings cannot reach them, and they run the real code between the input and the outcome, so bugs cannot hide behind a mock."
      : "Suite B never cried wolf. The bug it missed is a behaviour nobody wrote a test for. Fix that with a new test through Ship, not with a test of the private helper.";
  else if (s.refactors)
    take = s.falseAlarms.A > s.falseAlarms.B
      ? "Every red here is a false alarm: no outcome changed. Suite A names the pieces being moved around. Now plant some bugs."
      : "No false alarms yet. Try the refactorings that reshape a piece suite A names.";
  else
    take = "Now refactor: apply the changes that leave every outcome the same, and watch which suite goes red.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your two suites, by your numbers</span>
      {s.refactors > 0 && (
        <p>Of {n(s.refactors, "refactoring")} that changed nothing a caller can see, suite A went red on {s.falseAlarms.A} and needed {n(s.testEdits.A, "test edit")}; suite B went red on {s.falseAlarms.B}.</p>
      )}
      {s.bugs > 0 && (
        <p>Of {n(s.bugs, "real bug")} you planted, suite A missed {s.misses.A} and suite B missed {s.misses.B}.</p>
      )}
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function ObservableBehaviorPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const results = runAll(st.active, st);
  const s = score(st);
  const active = st.active ? CHANGES[st.active] : null;

  return (
    <PgFrame title="Refactor, then plant bugs" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p><code>Ship(order)</code> reserves stock, weighs the parcel, books a courier and marks the order shipped. Two suites test it and both pass today. Suite A checks each internal step. Suite B checks only what a caller can observe.</p>
        <p className="pg-rule"><b>Apply each change in the code map, one at a time. Refactorings should leave both suites green; bugs should turn them red.</b></p>
      </div>

      <PgPredict<Predict>
        question="Five refactorings, each changing no outcome at all. On how many will suite A go red?"
        options={[{ value: "none", label: "None: behaviour is unchanged" }, { value: "some", label: "One or two" }, { value: "most", label: "Four or five" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Suite A went red on {s.falseAlarms.A} of 5. Each of its tests names an internal piece: a mocked class, a setter, a private function. Every refactoring moves one of those pieces, so every refactoring breaks a test even though no customer could tell. Suite B went red on {s.falseAlarms.B}.</>}
      />

      <div className="ob-map">
        <div className="ob-col">
          <span className="label">Observable · what a caller can see</span>
          {BLOCKS.filter((b) => b.observable).map((b) => <BlockCard key={b.id} b={b} st={st} dispatch={dispatch} />)}
        </div>
        <div className="ob-col">
          <span className="label">Implementation details · free to change</span>
          {BLOCKS.filter((b) => !b.observable).map((b) => <BlockCard key={b.id} b={b} st={st} dispatch={dispatch} />)}
        </div>
      </div>

      <div className={"ob-banner" + (active ? " " + active.kind : "")} aria-live="polite">
        {active ? (
          <>
            <span className="label">{active.kind === "refactor" ? "Refactoring applied · no outcome changed" : "Bug planted · an outcome is now wrong"}</span>
            <p><b>{active.title}.</b> {active.what}</p>
            <PgButton onClick={() => dispatch({ type: "revert" })}>Back to today&apos;s code</PgButton>
          </>
        ) : <p className="muted">Today&apos;s code. Both suites pass. Pick a refactoring or a bug in the code map.</p>}
      </div>

      <div className="pg-sides">
        <Suite suite="A" results={results} st={st} dispatch={dispatch} />
        <Suite suite="B" results={results} st={st} dispatch={dispatch} />
      </div>

      <dl className="pg-stats">
        <div className={s.falseAlarms.A ? "bad" : ""}><dt>A false alarms</dt><dd>{s.falseAlarms.A} of {s.refactors}</dd></div>
        <div className={s.falseAlarms.B ? "bad" : ""}><dt>B false alarms</dt><dd>{s.falseAlarms.B} of {s.refactors}</dd></div>
        <div className={s.misses.A ? "bad" : ""}><dt>A bugs missed</dt><dd>{s.misses.A} of {s.bugs}</dd></div>
        <div className={s.misses.B ? "bad" : ""}><dt>B bugs missed</dt><dd>{s.misses.B} of {s.bugs}</dd></div>
      </dl>
      <p className="muted">Tried {st.tried.filter((c) => REFACTORS.includes(c as RefactorId)).length} of 5 refactorings and {st.tried.filter((c) => BUGS.includes(c as BugId)).length} of 4 bugs. Suite A has {TESTS.filter((t) => t.suite === "A").length} tests; suite B has {activeTests(st).filter((t) => t.suite === "B").length}.</p>

      <Result st={st} />

      <div className="ob-challenges">
        <span className="label">Challenges</span>
        <ul>{challenges(st).map((c) => <li key={c.id} className={c.done ? "done" : ""}>{c.done ? "✓ " : "○ "}{c.text}</li>)}</ul>
      </div>

      <PgSources links={[
        { title: "Google Testing Blog: Test Behavior, Not Implementation", href: "https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html" },
        { title: "Change-Detector Tests Considered Harmful", href: "https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html" },
        { title: "Kent Beck's Test Desiderata (structure-insensitive)", href: "https://testdesiderata.com/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.ob-map { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.ob-col { display: grid; gap: 6px; align-content: start; }
.ob-block { border: 1px solid var(--line); background: var(--bg); padding: 6px 8px; display: grid; gap: 3px; transition: background .25s var(--ease), border-color .25s var(--ease); }
.ob-block.obs { border-left: 3px solid var(--accent); }
.ob-block.impl { border-style: dashed; }
.ob-block.changed { background: var(--hl); border-color: var(--accent); border-style: solid; }
.ob-name { font-size: .78rem; font-weight: 600; }
.ob-block .muted { font-size: .82rem; }
.ob-touch { display: flex; flex-wrap: wrap; gap: 3px; }
.ob-chip { font-size: .66rem; padding: 0 4px; border: 1px solid var(--line); }
.ob-chip.A { color: var(--pain); border-color: var(--pain); }
.ob-chip.B { color: var(--accent); border-color: var(--accent); }
.ob-acts { display: grid; gap: 3px; }
.ob-act { text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 3px 8px; font-size: .82rem; color: var(--ink); }
.ob-act.bug { border-color: var(--pain); }
.ob-act.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.ob-banner { border: 1px solid var(--line); background: var(--surface); padding: 8px 12px; display: grid; gap: 6px; justify-items: start; }
.ob-banner.refactor { border-color: var(--accent); }
.ob-banner.bug { border-color: var(--pain); background: var(--pain-bg); }
.ob-banner p { margin: 0; }
.ob-tests { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ob-tests li { display: grid; grid-template-columns: 2.4em minmax(0, 1fr); gap: 6px; border-left: 3px solid var(--good); background: var(--surface); padding: 4px 6px; transition: border-color .2s var(--ease), background .2s var(--ease); }
.ob-tests li.red { border-left-color: var(--pain); background: var(--pain-bg); }
.ob-tests li > div { display: grid; gap: 2px; min-width: 0; font-size: .88rem; }
.ob-tests code { font-size: .7rem; word-break: break-word; }
.ob-tid { font-family: var(--f-code); font-size: .7rem; color: var(--ink-2); padding-top: 2px; }
.ob-why { font-size: .84rem; color: var(--pain); }
.ob-why.blind { color: var(--ink-2); font-style: italic; }
.ob-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.ob-challenges li.done { color: var(--good); }
@media (max-width: 760px) { .ob-map { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .ob-block, .ob-tests li { transition: none; } }
`;
