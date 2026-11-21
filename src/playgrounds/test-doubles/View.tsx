"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  KIND_NOTE, KINDS, PREDICT_ANSWER, SCENARIOS, challenges, init, predictRevealed, step, tallyOf, verdict,
  type Action, type Kind, type Predict, type ScenarioRun, type Slot, type State, type Tally, type Verdict,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const LABEL: Record<Verdict, string> = { green: "✓ green", broken: "✗ red", caught: "✓ caught", missed: "✗ missed", "false-alarm": "✗ false alarm" };
const GOOD: Record<Verdict, boolean> = { green: true, caught: true, broken: false, missed: false, "false-alarm": false };

function SlotCard({ slot, st, dispatch }: { slot: Slot; st: State; dispatch: (a: Action) => void }) {
  const kind = st[slot];
  return (
    <div className={"td-slot td-" + slot}>
      <span className="label">{slot === "repo" ? "OrderRepo · queries, data comes in" : "Mailer · a command, the email leaves"}</span>
      <PgChoice<Kind> label={slot === "repo" ? "Double for OrderRepo" : "Double for Mailer"} value={kind}
        options={KINDS.map((k) => ({ value: k, label: KIND_NOTE[k].name, note: KIND_NOTE[k][slot] }))}
        onChange={(k) => dispatch({ type: "pick", slot, kind: k })} />
      <p className="muted">{KIND_NOTE[kind][slot]}</p>
    </div>
  );
}

function Board({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const groups: { title: string; kind: "base" | "bug" | "refactor" }[] = [
    { title: "Today's code", kind: "base" },
    { title: "Plant a bug: the suite should go red", kind: "bug" },
    { title: "Refactor: nothing a customer could notice changes", kind: "refactor" },
  ];
  return (
    <div className="td-board">
      {groups.map((g) => (
        <div key={g.kind} className="td-group">
          <span className="label">{g.title}</span>
          {SCENARIOS.filter((s) => s.kind === g.kind).map((s) => {
            const r = st.runs[s.id];
            const v = r ? verdict(r) : null;
            const sel = st.selected === s.id;
            return (
              <div key={s.id} className={"td-row" + (sel ? " sel" : "")}>
                <div className="td-what"><b>{s.title}</b><span className="muted">{s.what}</span></div>
                <button className={"td-cell" + (v ? (GOOD[v] ? " good" : " bad") : "")} aria-pressed={sel}
                  aria-label={`${s.title}: ${v ? LABEL[v] : "run the suite"}`}
                  onClick={() => dispatch(r ? { type: "select", scenario: s.id } : { type: "run", scenario: s.id })}>
                  {v ? LABEL[v] : "Run suite"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Trace({ r }: { r: ScenarioRun | undefined }) {
  if (!r) return <p className="pg-empty">Run a row, then read here which calls the service made and which assertion failed.</p>;
  const s = SCENARIOS.find((x) => x.id === r.scenario)!;
  return (
    <div className="td-trace" aria-live="polite">
      <span className="label">{s.title}: the two tests</span>
      {r.tests.map((t) => (
        <div key={t.test} className={"pg-entry" + (t.pass ? " ok" : " fail")}>
          <b className="td-tname">{t.test === "t1" ? "test 1 · sends the receipt" : "test 2 · unknown order"}</b>
          <ol className="td-calls">
            {t.calls.length === 0 && <li className="muted">no calls</li>}
            {t.calls.map((c, i) => <li key={i} className={(c.ok ? "" : "bad ") + c.who}><code>{c.who}.{c.text}</code></li>)}
          </ol>
          <p>{t.pass ? "✓ " : "✗ "}{t.reason}</p>
        </div>
      ))}
    </div>
  );
}

function name(t: Pick<Tally, "repo" | "mailer">) { return `${KIND_NOTE[t.repo].name} repo + ${KIND_NOTE[t.mailer].name} mailer`; }

function Result({ st }: { st: State }) {
  const ok = st.history.filter((h) => !h.broken);
  if (!st.history.length) return null;
  const cur = tallyOf(st);
  const lines: string[] = [];
  if (cur?.broken) lines.push("This pair fails on today's code before any bug is planted: a dummy was called. A dummy only fills a parameter the code never touches.");
  // Same mailer, different repo doubles: did verifying the repo buy anything?
  for (const mailer of new Set(ok.map((h) => h.mailer))) {
    const rows = ok.filter((h) => h.mailer === mailer);
    const verifying = rows.filter((h) => h.repo === "spy" || h.repo === "mock");
    const feeding = rows.filter((h) => h.repo === "stub" || h.repo === "fake");
    if (verifying.length && feeding.length) {
      const extra = Math.max(...verifying.map((h) => h.caught)) - Math.max(...feeding.map((h) => h.caught));
      const alarms = Math.max(...verifying.map((h) => h.falseAlarms)) - Math.min(...feeding.map((h) => h.falseAlarms));
      lines.push(`With a ${KIND_NOTE[mailer].name.toLowerCase()} mailer, checking the repository's calls caught ${n(Math.max(extra, 0), "extra bug")} and added ${n(alarms, "false alarm")}.`);
    }
  }
  const stubMail = ok.find((h) => h.mailer === "stub");
  if (stubMail) lines.push(`With a stub mailer, ${stubMail.caught} of 5 bugs were caught: the email is the outcome, and nothing looked at it.`);
  const best = [...ok].sort((a, b) => b.caught - a.caught || a.falseAlarms - b.falseAlarms)[0];
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your suites did</span>
      <p>You ran {n(st.history.length, "pair")} of doubles against all nine rows.{best ? ` Best so far: ${name(best)}, ${best.caught} of 5 bugs caught, ${n(best.falseAlarms, "false alarm")}.` : ""}</p>
      {lines.map((l, i) => <p key={i}>{l}</p>)}
      <p className="pg-takeaway">
        {best && best.caught === 5 && best.falseAlarms === 0
          ? "Every bug was in what left the service, so only the mailer's double needed checking. Feed the queries with a stub or a fake and assert nothing on them; check the command that leaves with a mock, a spy or a fake outbox."
          : "Try more pairs. Watch which slot changes the bugs caught and which slot changes the false alarms."}
      </p>
    </div>
  );
}

export default function TestDoublesPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const cur = tallyOf(st);
  const runs = Object.values(st.runs);
  const vs = runs.map((r) => verdict(r!));
  const caught = vs.filter((v) => v === "caught").length;
  const missed = vs.filter((v) => v === "missed").length;
  const alarms = vs.filter((v) => v === "false-alarm").length;
  const broken = vs.includes("broken");

  return (
    <PgFrame title="Pick a double, plant bugs, refactor" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p><code>SendReceipt(orderId)</code> loads an order and its customer from <code>OrderRepo</code>, then emails a receipt through <code>Mailer</code>. Its suite has two tests. Choose a test double for each dependency, then run the suite against planted bugs and harmless refactorings.</p>
        <p className="pg-rule"><b>A good suite goes red for every bug and stays green for every refactoring.</b></p>
      </div>

      <PgPredict<Predict>
        question="Keep the mailer fixed. Which double for OrderRepo catches the most bugs?"
        options={[{ value: "mock", label: "A mock: it checks every call" }, { value: "fake", label: "A fake: it really works" }, { value: "same", label: "They catch the same bugs" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Every working repository double catches the same bugs. The bugs show up in the email that leaves, so the mailer&apos;s double decides what is caught. Checking how the order was fetched adds nothing to catch and only breaks when the fetching changes.</>}
      />

      <div className="td-wire" aria-label="The service and its two dependencies">
        <SlotCard slot="repo" st={st} dispatch={dispatch} />
        <div className="td-sut">
          <span className="td-arrow in" aria-hidden="true">data in ←</span>
          <b>SendReceipt</b>
          <span className="muted">the code under test</span>
          <span className="td-arrow out" aria-hidden="true">→ email out</span>
        </div>
        <SlotCard slot="mailer" st={st} dispatch={dispatch} />
      </div>

      <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "runAll" })}>Run all nine rows</PgButton></div>

      <div className="pg-grid">
        <Board st={st} dispatch={dispatch} />
        <Trace r={st.selected ? st.runs[st.selected] : undefined} />
      </div>

      <dl className="pg-stats">
        <div className={broken ? "bad" : ""}><dt>Today&apos;s code</dt><dd>{st.runs.correct ? (broken ? "red" : "green") : "not run"}</dd></div>
        <div className={missed ? "bad" : ""}><dt>Bugs caught</dt><dd>{caught} of 5{missed ? ` · ${missed} missed` : ""}</dd></div>
        <div className={alarms ? "bad" : ""}><dt>False alarms</dt><dd>{alarms} of 3</dd></div>
        <div><dt>Pairs tried</dt><dd>{st.history.length}{cur ? "" : " · this one partly"}</dd></div>
      </dl>

      {st.history.length > 0 && (
        <div className="td-wrap">
          <table className="td-history">
            <caption className="label">Every pair you ran in full</caption>
            <thead><tr><th scope="col">OrderRepo</th><th scope="col">Mailer</th><th scope="col">Bugs caught</th><th scope="col">False alarms</th></tr></thead>
            <tbody>
              {st.history.map((h) => (
                <tr key={h.repo + h.mailer}>
                  <td>{KIND_NOTE[h.repo].name}</td><td>{KIND_NOTE[h.mailer].name}</td>
                  <td className={h.broken ? "bad" : h.caught === 5 ? "good" : "bad"}>{h.broken ? "red on today's code" : `${h.caught} of 5`}</td>
                  <td className={h.falseAlarms ? "bad" : "good"}>{h.falseAlarms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Result st={st} />

      <div className="td-challenges">
        <span className="label">Challenges</span>
        <ul>{challenges(st).map((c) => <li key={c.id} className={c.done ? "done" : ""}>{c.done ? "✓ " : "○ "}{c.text}</li>)}</ul>
      </div>

      <PgSources links={[
        { title: "Martin Fowler: Mocks Aren't Stubs", href: "https://martinfowler.com/articles/mocksArentStubs.html" },
        { title: "Gerard Meszaros: Test Double patterns", href: "http://xunitpatterns.com/Test%20Double.html" },
        { title: "Vladimir Khorikov: When to Mock", href: "https://enterprisecraftsmanship.com/posts/when-to-mock/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.td-wire { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .7fr) minmax(0, 1fr); gap: 8px; align-items: stretch; }
.td-slot { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.td-slot.td-mailer { border-color: var(--accent); }
.td-slot .muted { font-size: .85rem; }
.td-sut { border: 2px solid var(--ink); background: var(--surface); padding: 8px; display: grid; gap: 4px; align-content: center; justify-items: center; text-align: center; }
.td-sut b { font-family: var(--f-code); font-size: .85rem; }
.td-arrow { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.td-arrow.out { color: var(--accent); }
.td-board { display: grid; gap: 10px; align-content: start; }
.td-group { display: grid; gap: 4px; }
.td-row { display: grid; grid-template-columns: minmax(0, 1fr) 8.5em; gap: 6px; align-items: center; border: 1px solid var(--line); background: var(--bg); padding: 4px 6px; }
.td-row.sel { outline: 2px solid var(--accent); outline-offset: -1px; }
.td-what { display: grid; gap: 1px; font-size: .9rem; min-width: 0; }
.td-what .muted { font-size: .8rem; }
.td-cell { min-height: 32px; border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .72rem; color: var(--ink); transition: background .2s var(--ease); }
.td-cell.good { background: var(--good-bg); color: var(--good); }
.td-cell.bad { background: var(--pain-bg); color: var(--pain); font-weight: 600; }
.td-trace { display: grid; gap: 6px; align-content: start; }
.td-tname { font-family: var(--f-code); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
.td-calls { margin: 2px 0; padding-left: 1.3em; display: grid; gap: 2px; font-size: .85rem; }
.td-calls code { font-size: .72rem; word-break: break-word; }
.td-calls li.mailer code { color: var(--accent); }
.td-calls li.bad code { color: var(--pain); font-weight: 600; }
.td-wrap { overflow-x: auto; }
.td-history { border-collapse: collapse; width: 100%; min-width: 320px; font-size: .88rem; }
.td-history caption { text-align: left; padding-bottom: 6px; }
.td-history th, .td-history td { border: 1px solid var(--line); padding: 3px 8px; text-align: left; }
.td-history th { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; }
.td-history td.good { color: var(--good); }
.td-history td.bad { color: var(--pain); font-weight: 600; }
.td-challenges ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 3px; font-size: .95rem; }
.td-challenges li.done { color: var(--good); }
@media (max-width: 760px) { .td-wire { grid-template-columns: 1fr; } .td-row { grid-template-columns: minmax(0, 1fr) 7.5em; } }
@media (prefers-reduced-motion: reduce) { .td-cell { transition: none; } }
`;
