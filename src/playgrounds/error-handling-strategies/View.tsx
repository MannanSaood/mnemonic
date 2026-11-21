"use client";
import { useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  FAULT, FAULTS, GOALS, LAYER, POLICIES, POLICY, ROOT, init, score, step,
  type Action, type Fault, type Layer, type PredictChoice, type Run, type State, type Trace,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const WHO: Record<Trace["layer"], string> = { handler: "Handler", service: "Service", payment: "Payment", repo: "Repo", api: "Provider", db: "Database" };

function LayerCard({ st, id, dispatch }: { st: State; id: Layer; dispatch: (a: Action) => void }) {
  const l = LAYER[id];
  const did = st.last?.did[id];
  const p = st.policies[id];
  const cls = "eh-layer" + (did && did !== "passed" ? ` did-${did}` : "");
  return (
    <div className={cls}>
      <div className="eh-head">
        <b>{l.name}</b>
        <span className="eh-calls">calls {l.calls}</span>
      </div>
      <div className="eh-pols" role="radiogroup" aria-label={`${l.name}: on error`}>
        {POLICIES.map((o) => (
          <button key={o.id} role="radio" aria-checked={p === o.id} className={"eh-pol" + (p === o.id ? " on" : "")}
            title={o.code} onClick={() => dispatch({ type: "policy", layer: id, policy: o.id })}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="eh-code">on error: {POLICY[p].code}</p>
      {did && <span className="eh-did">{did === "passed" ? "passed it up" : `did: ${POLICY[did].label.toLowerCase()}`}</span>}
    </div>
  );
}

function External({ name, faults, st, dispatch }: { name: string; faults: Fault[]; st: State; dispatch: (a: Action) => void }) {
  return (
    <div className="eh-ext">
      <span className="label">{name}</span>
      <div className="eh-faults">
        {faults.map((f) => (
          <button key={f} className={"eh-fault" + (st.fault === f ? " on" : "")} aria-pressed={st.fault === f}
            title={FAULT[f].detail} onClick={() => dispatch({ type: "inject", fault: f })}>
            ⚡ {FAULT[f].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Outcome({ r, reduced }: { r: Run; reduced: boolean }) {
  const v = r.verdict;
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  return (
    <>
      <p className="eh-faultline"><b>Injected:</b> {FAULT[r.fault].detail}</p>
      <div className="eh-three">
        <div className={"pg-card" + (v.honest ? "" : " eh-bad")}>
          <span className="label">{mark(v.honest)} What the customer sees</span>
          <p className="eh-status"><code>{r.status}</code> {r.shown}</p>
        </div>
        <div className={"pg-card" + (v.causeLogged ? "" : " eh-bad")}>
          <span className="label">{mark(v.causeLogged)} What the logs say</span>
          {r.logs.length ? r.logs.map((l, i) => <p key={i} className="eh-logline">{l}</p>) : <p className="eh-logline muted">(nothing)</p>}
        </div>
        <div className={"pg-card" + (v.moneyRight ? "" : " eh-bad")}>
          <span className="label">{mark(v.moneyRight)} What really happened</span>
          <dl className="pg-stats">
            <div className={r.charges > 1 || (r.charges !== r.saves) ? "bad" : ""}><dt>Card charged</dt><dd>{r.charges}×</dd></div>
            <div className={r.charges !== r.saves ? "bad" : ""}><dt>Orders saved</dt><dd>{r.saves}</dd></div>
            <div><dt>API calls</dt><dd>{r.apiCalls}</dd></div>
          </dl>
        </div>
      </div>
      {v.problems.length > 0 && (
        <ul className="eh-problems">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      <details className="eh-trace">
        <summary>Trace the request, call by call ({r.trace.length} steps)</summary>
        <div className="pg-log">
          {r.trace.map((t, i) => (
            <div key={`${r.fault}-${i}-${t.text}`} className={"pg-entry" + (t.tone === "fail" || t.tone === "swallow" ? " fail" : " ok") + (reduced ? "" : " fresh")}>
              <div className="pg-path" aria-hidden="true">
                <span style={{ animationDelay: `${i * 90}ms` }}>{WHO[t.layer]}</span>
                <span style={{ animationDelay: `${i * 90 + 45}ms` }}>{t.tone}</span>
              </div>
              <p>{t.text}</p>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function Matrix({ runs }: { runs: Run[] }) {
  const cell = (ok: boolean | null) => (ok === null ? <td className="muted">n/a</td> : <td className={ok ? "eh-ok" : "eh-no"}>{ok ? "✓" : "✗"}</td>);
  return (
    <table className="eh-table">
      <thead><tr><th>Fault</th><th>Customer told the truth</th><th>Cause in logs</th><th>Money right</th><th>Recovered</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.fault}>
            <td>{FAULT[r.fault].label}</td>
            {cell(r.verdict.honest)}{cell(r.verdict.causeLogged)}{cell(r.verdict.moneyRight)}{cell(r.verdict.recovered)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Takeaway({ st }: { st: State }) {
  const runs = st.matrix ?? (st.last ? [st.last] : []);
  const totals = runs.reduce((a, r) => { const s = score(r.verdict); return { p: a.p + s.passed, t: a.t + s.total }; }, { p: 0, t: 0 });
  const lies = runs.filter((r) => !r.verdict.honest).length;
  const lost = runs.filter((r) => !r.verdict.causeLogged).length;
  const money = runs.filter((r) => !r.verdict.moneyRight).length;
  const p = st.policies;
  let why: string;
  if (p.payment === "swallow" || p.payment === "log" || p.repo === "swallow" || p.repo === "log" || p.service === "swallow" || p.service === "log")
    why = "A layer below the handler hides failures, so every layer above it believes the work was done. Logging it does not help: the log is right and the order is still wrong.";
  else if (p.service === "retry" || p.handler === "retry")
    why = "A retry wrapped around the whole order repeats the charge too. Retry only the one call that failed, next to it, where you know it is safe to repeat.";
  else if (p.payment === "message" || p.repo === "message" || p.service === "message")
    why = "A deep layer turned the error into customer text. The handler can no longer tell a decline from an outage, and the logs lost the cause.";
  else if (p.handler !== "message")
    why = "The handler is the edge. It is the one place that should turn an error into a status and a message, and log the whole chain once.";
  else if (p.payment !== "retry" || p.repo !== "retry")
    why = "Nothing lies now, but transient faults still fail orders. Retry them in the client that made the call.";
  else
    why = "Each layer does one job: the clients retry transient failures, the service adds context, the handler translates and logs once.";
  return (
    <p className="pg-takeaway">
      {st.matrix ? "Against all four faults" : `On this run (${FAULT[runs[0].fault].label.toLowerCase()})`}, your policies passed {totals.p} of {n(totals.t, "check")}:
      {" "}{n(lies, "dishonest answer")}, {n(lost, "lost root cause", "lost root causes")}, {n(money, "money error")}. {why}
    </p>
  );
}

export default function ErrorHandlingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<PredictChoice | null>(null);
  const r = st.last;
  const downRun = st.runs > 0 && (st.fault === "down" || st.matrix !== null);

  return (
    <PgFrame title="Where does each error get handled?" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <PgPredict<PredictChoice>
        question="The payment provider is down. The payment client logs the error and carries on; every other layer wraps or translates. What does the customer see?"
        options={[
          { value: "error", label: "An error: payments unavailable" },
          { value: "placed", label: "\"Order placed\"" },
          { value: "declined", label: "\"Card declined\"" },
        ]}
        value={guess}
        onChange={setGuess}
        revealed={downRun}
        answer="placed"
        explain={<>The payment client returned success, so the service saved the order and the handler said it was placed. The order ships and the card was never charged. The log line is correct, and nobody reads it in time. One layer that hides a failure lies to every layer above it.</>}
      />

      <p className="pg-rule"><b>Pick what each layer does with an error, then inject a failure</b> at the provider or the database. Changing a policy re-runs the same failure.</p>

      <div className="eh-stack">
        <LayerCard st={st} id="handler" dispatch={dispatch} />
        <div className="eh-arrow" aria-hidden="true">↓ calls · errors return ↑</div>
        <LayerCard st={st} id="service" dispatch={dispatch} />
        <div className="eh-arrow" aria-hidden="true">↓ 1. charge · 2. save ↓</div>
        <div className="eh-pair">
          <div className="eh-col">
            <LayerCard st={st} id="payment" dispatch={dispatch} />
            <External name="Payment provider API" faults={["blip", "down", "declined"]} st={st} dispatch={dispatch} />
          </div>
          <div className="eh-col">
            <LayerCard st={st} id="repo" dispatch={dispatch} />
            <External name="Orders database" faults={["dbTimeout"]} st={st} dispatch={dispatch} />
          </div>
        </div>
      </div>

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "runAll" })}>Run all four faults</PgButton>
        <span className="muted">Root causes: <code>{ROOT.down}</code>, <code>{ROOT.declined}</code>, <code>{ROOT.dbTimeout}</code></span>
      </div>

      <div aria-live="polite">
        {r ? <Outcome r={r} reduced={reduced} /> : <p className="pg-empty">No request yet. Click ⚡ Provider down under the payment client.</p>}
      </div>

      {st.matrix && (
        <div className="pg-card">
          <span className="label">Your policies against every fault</span>
          <Matrix runs={st.matrix} />
        </div>
      )}

      {(r || st.matrix) && (
        <div className="pg-result">
          <span className="label">Challenges</span>
          <ul className="eh-goals">
            {GOALS.map((g) => <li key={g.id} className={st.goals.includes(g.id) ? "done" : ""}><span aria-hidden="true">{st.goals.includes(g.id) ? "■" : "□"}</span> {g.text}</li>)}
          </ul>
          <Takeaway st={st} />
        </div>
      )}

      <PgSources links={[
        { title: "Scott Wlaschin, Railway Oriented Programming", href: "https://fsharpforfunandprofit.com/rop/" },
        { title: "Go blog, Working with Errors in Go 1.13", href: "https://go.dev/blog/go1.13-errors" },
        { title: "Joe Duffy, The Error Model", href: "https://joeduffyblog.com/2016/02/07/the-error-model/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.eh-stack { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 16px 16px; }
.eh-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.eh-col { display: grid; gap: 4px; align-content: start; }
.eh-arrow { font-family: var(--f-code); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); text-align: center; }
.eh-layer { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; min-width: 0; transition: border-color .25s var(--ease), background-color .25s var(--ease); }
.eh-layer.did-swallow, .eh-layer.did-log, .eh-layer.did-message { border: 2px solid var(--pain); background: var(--pain-bg); }
.eh-layer.did-wrap, .eh-layer.did-retry { border: 2px solid var(--accent); }
.eh-head { display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.eh-head b { font-family: var(--f-code); text-transform: uppercase; letter-spacing: .06em; font-size: .82rem; }
.eh-calls { font-size: .75rem; color: var(--ink-2); }
.eh-pols { display: flex; flex-wrap: wrap; gap: 3px; }
.eh-pol { border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .66rem; padding: 2px 6px; color: var(--ink); }
.eh-pol.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.eh-code { margin: 0; font-size: .78rem; color: var(--ink-2); }
.eh-did { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--pain); }
.eh-layer.did-wrap .eh-did, .eh-layer.did-retry .eh-did { color: var(--accent); }
.eh-ext { border: 1px dashed var(--line); background: var(--surface-2); padding: 6px 8px; display: grid; gap: 4px; }
.eh-faults { display: flex; flex-wrap: wrap; gap: 4px; }
.eh-fault { border: 1px solid var(--pain); background: var(--surface); color: var(--pain); font-size: .78rem; padding: 2px 8px; }
.eh-fault.on { background: var(--pain); color: var(--bg); }
.eh-faultline { margin: 0; }
.eh-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.eh-bad { border-color: var(--pain); background: var(--pain-bg); }
.eh-status { margin: 0; }
.eh-logline { margin: 0; font-family: var(--f-code); font-size: .72rem; overflow-wrap: anywhere; }
.eh-problems { margin: 0; padding-left: 1.2em; color: var(--pain); }
.eh-trace summary { cursor: pointer; font-size: .9rem; }
.eh-table { border-collapse: collapse; width: 100%; font-size: .88rem; }
.eh-table th, .eh-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; }
.eh-table th { font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.eh-ok { color: var(--good); }
.eh-no { color: var(--pain); background: var(--pain-bg); }
.eh-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.eh-goals li { color: var(--ink-2); }
.eh-goals li.done { color: var(--good); }
@media (max-width: 720px) { .eh-three { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .eh-pair { grid-template-columns: 1fr; } .eh-table { font-size: .76rem; } }
@media (prefers-reduced-motion: reduce) { .eh-layer { transition: none; } }
`;
