"use client";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BASE_NAME, BASE_SIG, CALLS, DECS, DEC_JOB, DEC_LINE, DEC_NAME, GOALS, START, allGoalsMet, init, step, totals,
  type Action, type DecId, type Guess, type Run, type State, type TraceLine,
} from "./model";

const CSS = `
.cd-src { margin: 0; padding: 8px 10px; border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .78rem; line-height: 1.6; overflow-x: auto; }
.cd-src .dim { color: var(--ink-2); }
.cd-stack { display: grid; gap: 4px; }
.cd-dec { border: 1px solid var(--line); background: var(--surface); padding: 5px 7px; display: grid; gap: 3px; }
.cd-dec header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.cd-dec code { font-family: var(--f-code); font-size: .78rem; font-weight: 600; }
.cd-dec p { margin: 0; font-size: .82rem; color: var(--ink-2); line-height: 1.3; }
.cd-btns { display: flex; gap: 2px; flex-wrap: wrap; }
.cd-btns .pg-btn { padding: 1px 7px; font-size: .76rem; }
.cd-btns .pg-btn.off { color: var(--pain); border-color: var(--pain); }
.cd-def { border: 1px dashed var(--ink-2); padding: 5px 7px; font-family: var(--f-code); font-size: .76rem; }
.cd-calls { display: grid; gap: 8px; }
.cd-call { border: 1px solid var(--line); background: var(--surface); }
.cd-call > header { display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; padding: 4px 8px; background: var(--surface-2); font-family: var(--f-code); font-size: .72rem; }
.cd-call > header .bad { color: var(--pain); font-weight: 700; }
.cd-call > header .ok { color: var(--good); font-weight: 700; }
.cd-trace { margin: 0; padding: 4px 8px 6px; list-style: none; font-family: var(--f-code); font-size: .7rem; line-height: 1.5; }
.cd-trace li { white-space: pre-wrap; }
.cd-k-http-fail, .cd-k-raise { color: var(--pain); }
.cd-k-http-ok, .cd-k-hit { color: var(--good); }
.cd-k-sample { color: var(--accent); font-weight: 600; }
.cd-k-sample.bad { color: var(--pain); }
.cd-k-sleep { color: var(--ink-2); }
.cd-meta { width: 100%; border-collapse: collapse; font-size: .84rem; }
.cd-meta th, .cd-meta td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; font-family: var(--f-code); font-size: .74rem; }
.cd-meta td.bad { color: var(--pain); font-weight: 600; }
.cd-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.cd-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.cd-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.cd-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.cd-scroll { overflow-x: auto; }
.cd-fresh { animation: pg-hop .35s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .cd-fresh { animation: none; } }
`;

function Stack({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const missing = DECS.filter((d) => !st.stack.includes(d));
  return (
    <div className="cd-stack">
      <span className="label">The decorators, top line first</span>
      {st.stack.map((d, i) => (
        <div key={d} className="cd-dec">
          <header>
            <code>{DEC_LINE[d]}</code>
            <span className="cd-btns">
              <PgButton onClick={() => dispatch({ type: "move", dec: d, dir: -1 })} disabled={i === 0} title={`Move ${DEC_NAME[d]} up a line (further out)`}>↑</PgButton>
              <PgButton onClick={() => dispatch({ type: "move", dec: d, dir: 1 })} disabled={i === st.stack.length - 1} title={`Move ${DEC_NAME[d]} down a line (further in)`}>↓</PgButton>
              {d !== "cache" && (
                <button className={"pg-btn" + (st.wraps[d] ? "" : " off")} aria-pressed={st.wraps[d]} onClick={() => dispatch({ type: "wraps", dec: d })}
                  title="Toggle @functools.wraps(fn) on this decorator's inner wrapper">
                  @wraps {st.wraps[d] ? "on" : "off"}
                </button>
              )}
              <PgButton onClick={() => dispatch({ type: "remove", dec: d })} title={`Remove ${DEC_NAME[d]}`}>×</PgButton>
            </span>
          </header>
          <p>{DEC_JOB[d]}</p>
        </div>
      ))}
      <div className="cd-def">def {BASE_NAME}{BASE_SIG}: <span className="muted">one HTTP GET</span></div>
      {missing.length > 0 && (
        <div className="pg-actions">
          {missing.map((d) => <PgButton key={d} onClick={() => dispatch({ type: "add", dec: d })}>+ {DEC_LINE[d]} (top line)</PgButton>)}
        </div>
      )}
    </div>
  );
}

const INDENT = "  ";
function Trace({ lines }: { lines: TraceLine[] }) {
  return (
    <ol className="cd-trace">
      {lines.map((l, i) => (
        <li key={i} className={`cd-k-${l.kind}` + (l.kind === "sample" && !l.text.includes(`"${BASE_NAME}"`) ? " bad" : "")}>
          {INDENT.repeat(l.depth)}{l.kind === "enter" ? "→ " : "  "}{l.text}
        </li>
      ))}
    </ol>
  );
}

function Calls({ r, reduced, fresh }: { r: Run; reduced: boolean; fresh: number }) {
  return (
    <div className="cd-calls">
      {r.calls.map((c, i) => (
        <div key={`${fresh}-${i}`} className={"cd-call" + (reduced ? "" : " cd-fresh")} style={reduced ? undefined : { animationDelay: `${i * 90}ms` }}>
          <header>
            <span>#{c.call} {CALLS[i].label}: {CALLS[i].why}</span>
            <span className={c.ok ? "ok" : "bad"}>{c.ok ? "ok" : "ConnectError"} · {c.ms} ms · {c.http} HTTP</span>
          </header>
          <Trace lines={c.trace} />
        </div>
      ))}
    </div>
  );
}

function Meta({ r }: { r: Run }) {
  const m = r.meta;
  return (
    <div className="cd-scroll">
      <table className="cd-meta">
        <caption className="label" style={{ textAlign: "left", captionSide: "top" }}>What callers see on the name {BASE_NAME}</caption>
        <tbody>
          <tr><th scope="row">__name__</th><td className={m.name === BASE_NAME ? "" : "bad"}>{m.name}</td></tr>
          <tr><th scope="row">__doc__</th><td className={m.doc === "None" ? "bad" : ""}>{m.doc}</td></tr>
          <tr><th scope="row">inspect.signature</th><td className={m.signature === BASE_SIG ? "" : "bad"}>{m.signature}</td></tr>
          <tr><th scope="row">__wrapped__ chain</th><td className={m.wrappedDepth === r.stack.length ? "" : "bad"}>{m.wrappedDepth} of {r.stack.length} layers</td></tr>
          <tr><th scope="row">.cache_info()</th><td className={m.cacheInfo ? "" : "bad"}>{m.cacheInfo ? "works" : r.stack.includes("cache") ? "AttributeError: lru_cache is not outermost" : "AttributeError: no cache"}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

const order = (s: DecId[]) => s.length ? s.map((d) => DEC_NAME[d]).join(" → ") : "no decorators";
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const b = totals(st.baseline!), t = totals(st.run!);
  if (!allGoalsMet(st.run!)) return null;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p><b>Starting stack</b> ({order(START)}, @wraps off on retry): {n(b.samples, "latency sample")}, {b.wrapperSamples} of them named &quot;wrapper&quot;, {n(b.http, "HTTP call")}.</p>
      <p><b>Your stack</b> ({order(st.run!.stack)}): {n(t.samples, "latency sample")}, all named &quot;{BASE_NAME}&quot;, {n(t.http, "HTTP call")}, {n(t.hits, "cache hit")}. It took you {n(st.changes, "change")}.</p>
      <p className="pg-takeaway">The three decorators never changed. Their order decided who sees a cache hit and whether a sample covers the retries, and @wraps decided what name every layer above reported. A decorator replaces your function with its wrapper: order and metadata are part of the design.</p>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "fetch_invoice", label: '"fetch_invoice"' },
  { value: "wrapper", label: '"wrapper"' },
  { value: "retry", label: '"retry"' },
];

export default function ClosuresAndDecorators() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  return (
    <PgFrame title="Stack decorators on an API client" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Three decorators wrap <code>{BASE_NAME}</code>. The same three calls replay every time you change the stack. <b>Your job:
        meet all four goals below by moving lines and switching @wraps, without editing any decorator.</b>
      </p>

      <PgPredict<Guess>
        question={`Starting stack: ${START.map((d) => DEC_LINE[d]).join(", ")}. retry's wrapper has no @functools.wraps. Under what name does @timed record its latency samples?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={!!st.run}
        answer="wrapper"
        explain="timed reads fn.__name__ of the callable it wraps, and that callable is retry's inner function, called wrapper. @wraps on timed does not help: it copies the name of what it wraps, which is already wrong. Your dashboard gets a series called wrapper."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <Stack st={st} dispatch={dispatch} />
          <ul className="cd-goals" aria-label="Goals">
            {GOALS.map((g) => <li key={g.id} className={st.run && g.met(st.run) ? "met" : ""}>{g.text}</li>)}
          </ul>
          <pre className="cd-src" aria-label="Applied when def runs, bottom-up">
            <span className="dim"># when def runs (import time), bottom-up:</span>{"\n"}
            {(st.run?.importOrder ?? []).map((l, i) => <span key={i}>{i + 1}. {l}{"\n"}</span>)}
            {!st.run && <span className="dim">send the calls to see it</span>}
          </pre>
        </div>
        <div className="pg-card">
          {st.run ? (
            <>
              <span className="label">Each call, top-down through {order(st.run.stack)} → {BASE_NAME}</span>
              <Calls r={st.run} reduced={reduced} fresh={st.changes} />
              <dl className="pg-stats">
                <div><dt>HTTP calls</dt><dd>{totals(st.run).http}</dd></div>
                <div><dt>Cache hits</dt><dd>{totals(st.run).hits}</dd></div>
                <div><dt>Latency samples</dt><dd>{totals(st.run).samples}</dd></div>
                <div className={totals(st.run).wrapperSamples ? "bad" : ""}><dt>Named wrapper</dt><dd>{totals(st.run).wrapperSamples}</dd></div>
              </dl>
              <Meta r={st.run} />
              <Result st={st} />
            </>
          ) : (
            <>
              <span className="label">Calls</span>
              <p className="pg-empty">Nothing called yet. Make your prediction, then send the three calls. After that, every change to the stack replays them.</p>
              <PgButton primary onClick={() => dispatch({ type: "send" })}>Send {CALLS.length} calls</PgButton>
            </>
          )}
        </div>
      </div>

      <PgSources links={[
        { title: "Python Tutor's frames for closures", href: "https://pythontutor.com/" },
        { title: "Real Python's Primer on Python Decorators", href: "https://realpython.com/primer-on-python-decorators/" },
        { title: "the functools.wraps documentation", href: "https://docs.python.org/3/library/functools.html#functools.wraps" },
      ]} />
    </PgFrame>
  );
}
