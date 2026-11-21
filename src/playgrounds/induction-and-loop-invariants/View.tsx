"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CAUGHT_UP, CHALLENGES, CURSORS, INVARIANTS, LOG, N, POLLS_PER_HOUR, SHIPPED,
  duplicatesPerHour, holds, init, measure, proof, run, same, step, sweep, truth,
  type InvId, type Outcome, type State, type Trace,
} from "./model";

const OUTCOME: Record<Outcome, string> = { ok: "right", wrong: "wrong", hang: "never ends", crash: "out of range" };
const n0 = (x: number) => x.toLocaleString("en");

function LogRow({ st, t }: { st: State; t: Trace }) {
  const f = t.frames[st.pos];
  const crashHere = t.outcome === "crash" && st.pos === t.frames.length - 1;
  const ans = truth(st.since);
  const cells = Array.from({ length: N + 1 }, (_, i) => i);
  return (
    <div className="li-log" role="img"
      aria-label={`Event log of ${N} events. lo is ${f.lo}, hi is ${f.hi}${f.mid !== null ? `, the last mid read was ${f.mid}` : ""}. The right answer for since ${st.since} is index ${ans}.`}>
      {cells.map((i) => {
        const isEnd = i === N;
        const left = i < f.lo, right = i >= f.hi && !isEnd;
        const bad = !isEnd && ((left && !(LOG[i] < st.since)) || (right && !(LOG[i] >= st.since)));
        return (
          <div key={i} className={`li-cell${isEnd ? " end" : ""}${left ? " left" : ""}${right ? " right" : ""}${bad ? " bad" : ""}${i === ans ? " ans" : ""}`}>
            <span className="li-idx">{isEnd ? "n" : i}</span>
            <span className="li-seq">{isEnd ? "end" : LOG[i]}</span>
            <span className="li-marks">
              {i === f.lo && <b className="lo">lo</b>}
              {i === f.hi && <b className="hi">hi</b>}
              {(f.mid === i || (crashHere && t.crashMid === i)) && <b className="mid">mid</b>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Code({ st, dispatch }: { st: State; dispatch: (a: { type: "toggle"; line: "init" | "cond" | "left" }) => void }) {
  const v = st.v;
  const Line = ({ line, children, changed }: { line: "init" | "cond" | "left"; children: string; changed: boolean }) => (
    <button className={"li-tog" + (changed ? " changed" : "")} onClick={() => dispatch({ type: "toggle", line })}
      title="Click to switch this line">{children}</button>
  );
  return (
    <pre className="li-code" aria-label="The search, with three lines you can switch">
      <span className="c">{"// first index with seq >= since"}</span>{"\n"}
      {"lo, hi = 0, "}<Line line="init" changed={v.init !== SHIPPED.init}>{v.init === "n-1" ? "len(log) - 1" : "len(log)"}</Line>{"\n"}
      {"while "}<Line line="cond" changed={v.cond !== SHIPPED.cond}>{v.cond === "lt" ? "lo < hi" : "lo <= hi"}</Line>{":\n"}
      {"    mid = lo + (hi - lo) / 2\n"}
      {"    if log[mid] < since:\n"}
      {"        lo = "}<Line line="left" changed={v.left !== SHIPPED.left}>{v.left === "mid+1" ? "mid + 1" : "mid"}</Line>{"\n"}
      {"    else:\n"}
      {"        hi = mid\n"}
      {"return lo"}
    </pre>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={ok ? "li-ok" : "li-no"}>{ok ? "✓" : "✗"}</span>;
}

function Result({ st }: { st: State }) {
  const sw = sweep(st.v);
  const dup = duplicatesPerHour(st.v);
  const caught = run(st.v, CAUGHT_UP);
  const p = proof("split", caught, CAUGHT_UP);
  let take: string;
  if (sw.ok === CURSORS.length)
    take = `Every cursor is right. The split holds before the loop (base case), each iteration keeps it (step), and when lo = hi it names the answer. That is the whole proof, for every log length, not just these ${CURSORS.length} cursors.`;
  else if (sw.hang || sw.crash)
    take = `${sw.hang ? `${sw.hang} cursor${sw.hang === 1 ? "" : "s"} never finish: hi - lo stops shrinking, so nothing forces the loop to end. ` : ""}${sw.crash ? `${sw.crash} read past the end: with lo <= hi and hi = n, mid can reach n. ` : ""}An invariant proves the answer only if the loop also ends; that needs a measure that falls every iteration.`;
  else
    take = `${sw.wrong} of ${CURSORS.length} cursors come back wrong, and the one that matters is the caught-up consumer. The split invariant is ${p.base ? "true" : "already false"} before the first iteration${p.base ? "" : ", so the base case fails: the code claims event " + (N - 1) + " is ≥ since without ever looking"}. ${dup ? `At one poll a second that is ${n0(dup)} duplicate webhooks per consumer per hour.` : ""}`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your version does</span>
      <p>Lines: hi starts at {st.v.init === "n" ? "len(log)" : "len(log) - 1"}, loop while {st.v.cond === "lt" ? "lo < hi" : "lo <= hi"}, move right with lo = {st.v.left}. Over all {CURSORS.length} cursors: {sw.ok} right, {sw.wrong} wrong, {sw.hang} never end, {sw.crash} out of range. A consumer polling at the end of the log {dup ? `gets seq ${LOG[caught.result ?? 0]} again on every poll: ${n0(dup)} duplicates an hour at ${n0(POLLS_PER_HOUR)} polls` : caught.outcome === "ok" ? "gets nothing, which is right" : `sees the search ${OUTCOME[caught.outcome]}`}.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function LoopInvariantPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const t = run(st.v, st.since);
  const last = t.frames.length - 1;
  const atEnd = st.pos >= last;
  const pr = proof(st.inv, t, st.since);
  const sw = sweep(st.v);
  const shown = t.frames.slice(0, st.pos + 1);
  const shipped = same(st.v, SHIPPED);

  return (
    <PgFrame title="The cursor search behind a webhook poller" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict
        question={`A consumer has seen every event, so it polls with since = ${CAUGHT_UP}, past the last one. Step the shipped search with the split invariant. Where does the invariant first fail?`}
        options={[
          { value: "base", label: "Before the first iteration" },
          { value: "step", label: "Inside some iteration" },
          { value: "never", label: "Never, only the answer is wrong" },
        ]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.sawCaughtUp}
        answer="base"
        explain={<>With hi = len(log) − 1 the loop starts out claiming that event {N - 1} (seq {LOG[N - 1]}) is ≥ {CAUGHT_UP}. It is not, so the invariant is false before any work is done. Every iteration preserves it correctly, which is why the bug survives review: the step is fine, the base case is not.</>}
      />

      <div className="pg-req">
        <span className="label">The consumer's cursor · since =</span>
        <PgChoice<string> label="Cursor value" value={String(st.since)} onChange={(v) => dispatch({ type: "since", since: Number(v) })}
          options={CURSORS.map((c) => ({ value: String(c), label: c === CAUGHT_UP ? `${c} (caught up)` : String(c) }))} />
      </div>

      <div className={"pg-card" + (reduced ? "" : " li-anim")}>
        <span className="label">Event log · shaded left of lo: proved &lt; since · shaded from hi: proved ≥ since · outlined: the true answer</span>
        <LogRow st={st} t={t} />
        <div className="pg-actions">
          <PgButton onClick={() => dispatch({ type: "back" })} disabled={st.pos === 0}>Back</PgButton>
          <PgButton primary onClick={() => dispatch({ type: "step" })} disabled={atEnd}>{st.pos === 0 ? "Run first iteration" : "Next iteration"}</PgButton>
          <PgButton onClick={() => dispatch({ type: "end" })} disabled={atEnd}>Run to the end</PgButton>
          <PgButton onClick={() => dispatch({ type: "restart" })} disabled={st.pos === 0}>Restart</PgButton>
        </div>
        <p className={"li-status " + (atEnd ? t.outcome : "")} aria-live="polite">
          {!atEnd ? `Loop head, iteration ${st.pos}. lo = ${t.frames[st.pos].lo}, hi = ${t.frames[st.pos].hi}.`
            : t.outcome === "ok" ? `Returned ${t.result}: right. The page starts at ${t.result === N ? "the end, so it is empty" : `seq ${LOG[t.result!]}`}.`
            : t.outcome === "wrong" ? `Returned ${t.result}, but the first event ≥ ${st.since} is at ${truth(st.since)}${truth(st.since) === N ? " (none: the page should be empty)" : ""}. The consumer is sent seq ${LOG[t.result!]} again.`
            : t.outcome === "hang" ? "lo and hi did not change in that iteration, so the loop repeats it forever. The measure hi − lo stopped falling."
            : `mid = ${t.crashMid}, past the last event: index out of range. With lo <= hi and hi = len(log), the loop reads log[n].`}
        </p>
      </div>

      <div className="pg-grid li-two">
        <div className="pg-card">
          <span className="label">The code · click a boxed line to change it</span>
          <Code st={st} dispatch={dispatch} />
          <PgButton onClick={() => { for (const l of ["init", "cond", "left"] as const) if (st.v[l] !== SHIPPED[l]) dispatch({ type: "toggle", line: l }); }} disabled={shipped}>Back to the shipped code</PgButton>
        </div>
        <div className="pg-card">
          <span className="label">State the invariant · checked at every loop head</span>
          <div className="li-invs" role="radiogroup" aria-label="Invariant to check">
            {INVARIANTS.map((i) => (
              <button key={i.id} role="radio" aria-checked={st.inv === i.id} onClick={() => dispatch({ type: "inv", inv: i.id as InvId })}>
                <span>{i.text}</span><small>{i.note}</small>
              </button>
            ))}
          </div>
          <table className="li-table">
            <thead><tr><th>Iter</th><th>lo</th><th>hi</th><th>mid</th><th>hi − lo</th><th>Holds</th></tr></thead>
            <tbody>
              {shown.map((f, i) => (
                <tr key={i} className={i === st.pos ? "cur" : ""}>
                  <td>{i === 0 ? "start" : i}</td><td>{f.lo}</td><td>{f.hi}</td><td>{f.mid ?? "-"}</td>
                  <td className={i > 0 && measure(f) >= measure(shown[i - 1]) ? "li-no" : ""}>{measure(f)}</td>
                  <td><Mark ok={holds(st.inv, f, st.since)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="pg-stats li-proof">
            <div className={pr.base ? "" : "bad"}><dt>Base case</dt><dd>{pr.base ? "holds" : "fails"}</dd></div>
            <div className={pr.step ? "" : "bad"}><dt>Each step</dt><dd>{atEnd ? (pr.step ? "keeps it" : "breaks it") : "…"}</dd></div>
            <div className={atEnd && (pr.exit === "wrong" || pr.exit === "none") ? "bad" : ""}><dt>At exit</dt><dd>{!atEnd ? "…" : pr.exit === "proves" ? "names the answer" : pr.exit === "silent" ? "proves nothing" : pr.exit === "wrong" ? "false" : "never exits"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Every cursor through your version · the exhaustive test</span>
        <ul className="li-sweep">
          {sw.rows.map((r) => (
            <li key={r.since}>
              <button className={`li-chip ${r.trace.outcome}${r.since === st.since ? " sel" : ""}`} onClick={() => dispatch({ type: "since", since: r.since })}
                aria-label={`since ${r.since}: ${OUTCOME[r.trace.outcome]}`}>
                <span>{r.since}</span><small>{OUTCOME[r.trace.outcome]}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="li-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {(st.sawCaughtUp || !shipped) && <Result st={st} />}

      <PgSources links={[
        { title: "Cornell CS 2112 notes on loop invariants and binary search", href: "https://www.cs.cornell.edu/courses/cs2112/2020fa/lectures/loopinv" },
        { title: "Oakland University's binary search invariant visualizer", href: "https://www.secs.oakland.edu/~tianlema/3610/01_Lectures/L03/binary_search_invariant.html" },
        { title: "Joshua Bloch, Nearly All Binary Searches and Mergesorts are Broken", href: "https://research.google/blog/extra-extra-read-all-about-it-nearly-all-binary-searches-and-mergesorts-are-broken/" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.li-log { display: grid; grid-template-columns: repeat(${N + 1}, minmax(0, 1fr)); gap: 3px; }
.li-cell { display: grid; gap: 2px; justify-items: center; padding: 4px 0 2px; border: 1px solid var(--line); background: var(--surface); min-width: 0; }
.li-cell.end { border-style: dashed; color: var(--ink-2); }
.li-cell.left { background: color-mix(in srgb, var(--accent) 16%, var(--surface)); }
.li-cell.right { background: color-mix(in srgb, var(--good) 18%, var(--surface)); }
.li-cell.bad { outline: 2px solid var(--pain); outline-offset: -2px; background: var(--pain-bg); }
.li-cell.ans { box-shadow: inset 0 -3px 0 var(--ink); }
.li-anim .li-cell { transition: background-color .25s var(--ease); }
.li-idx { font-family: var(--f-code); font-size: .62rem; color: var(--ink-2); }
.li-seq { font-family: var(--f-code); font-size: .86rem; font-weight: 700; }
.li-marks { display: flex; flex-wrap: wrap; justify-content: center; gap: 1px; min-height: 1.1rem; }
.li-marks b { font-family: var(--f-code); font-size: .58rem; text-transform: uppercase; padding: 0 3px; color: var(--accent-ink); background: var(--accent); }
.li-marks b.hi { background: var(--good); }
.li-marks b.mid { background: var(--ink); color: var(--bg); }
.li-status { margin: 0; font-size: .92rem; border-left: 3px solid var(--line); padding-left: 8px; }
.li-status.ok { border-color: var(--good); } .li-status.wrong, .li-status.hang, .li-status.crash { border-color: var(--pain); }
.li-two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.li-code { margin: 0; font-family: var(--f-code); font-size: .8rem; line-height: 1.7; background: var(--surface); border: 1px solid var(--line); padding: 8px; overflow-x: auto; white-space: pre; }
.li-code .c { color: var(--ink-2); }
.li-tog { font: inherit; color: var(--ink); background: var(--hl); border: 1px dashed var(--accent); padding: 0 4px; cursor: pointer; }
.li-tog.changed { border-style: solid; border-color: var(--pain); background: var(--pain-bg); }
.li-invs { display: grid; gap: 4px; }
.li-invs button { text-align: left; display: grid; gap: 1px; padding: 5px 8px; background: var(--surface); border: 1px solid var(--line); color: var(--ink); font: inherit; font-size: .86rem; cursor: pointer; }
.li-invs button[aria-checked="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.li-invs small { color: var(--ink-2); font-size: .76rem; }
.li-table { width: 100%; border-collapse: collapse; font-family: var(--f-code); font-size: .76rem; font-variant-numeric: tabular-nums; }
.li-table th, .li-table td { border-bottom: 1px solid var(--line); padding: 2px 4px; text-align: center; }
.li-table th { font-weight: 400; color: var(--ink-2); text-transform: uppercase; font-size: .64rem; }
.li-table tr.cur td { background: var(--hl); }
.li-ok { color: var(--good); font-weight: 700; } .li-no { color: var(--pain); font-weight: 700; }
.li-proof { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.li-sweep { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.li-chip { display: grid; justify-items: center; padding: 3px 7px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-family: var(--f-code); font-size: .78rem; cursor: pointer; }
.li-chip small { font-size: .6rem; text-transform: uppercase; color: var(--ink-2); }
.li-chip.ok { border-color: var(--good); } .li-chip.ok small { color: var(--good); }
.li-chip.wrong, .li-chip.hang, .li-chip.crash { border-color: var(--pain); background: var(--pain-bg); } .li-chip.wrong small, .li-chip.hang small, .li-chip.crash small { color: var(--pain); }
.li-chip.sel { outline: 2px solid var(--ink); outline-offset: 1px; }
.li-list { list-style: none; padding-left: 0 !important; }
.li-list li.got { color: var(--good); }
@media (max-width: 700px) { .li-two { grid-template-columns: 1fr; } }
@media (max-width: 420px) { .li-seq { font-size: .72rem; } .li-marks b { font-size: .5rem; padding: 0 1px; } }
@media (prefers-reduced-motion: reduce) { .li-anim .li-cell { transition: none; } }
`;
