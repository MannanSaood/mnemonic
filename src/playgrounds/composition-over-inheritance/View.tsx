"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  FEATURES, FNAME, TEAMS, classTree, counts, explain, init, stackExpr, step,
  type ClassNode, type Feature, type State, type TeamId,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function depthOf(tree: ClassNode[], c: ClassNode): number {
  let d = 0;
  for (let p = c.parent; p !== "HttpClient"; d++) p = tree.find((x) => x.name === p)?.parent ?? "HttpClient";
  return d + 1;
}

function TeamGrid({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  return (
    <table className="coi-grid">
      <caption className="label">What each team needs from its HTTP client</caption>
      <thead><tr><th scope="col">Team</th>{FEATURES.map((f) => <th key={f} scope="col">{FNAME[f]}</th>)}</tr></thead>
      <tbody>
        {TEAMS.map((t) => (
          <tr key={t.id}>
            <th scope="row">{t.name}</th>
            {FEATURES.map((f) => {
              const on = st.teams[t.id].includes(f);
              return (
                <td key={f}>
                  <button className={"coi-cell" + (on ? " on" : "")} aria-pressed={on} aria-label={`${t.name} needs ${FNAME[f]}`}
                    onClick={() => dispatch({ type: "toggle", team: t.id, feature: f })}>{on ? "■" : "□"}</button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Inheritance({ st }: { st: State }) {
  const tree = classTree(st);
  const c = counts(st);
  return (
    <section className="pg-side" aria-label="Inheritance design">
      <header><h4>Subclass per mix</h4></header>
      <p className="muted">Each mix of features is a class. A class inherits one parent and writes the rest itself.</p>
      <div className="pgc coi-tree">
        <div className="pgc-line"><code>HttpClient</code></div>
        {tree.map((k) => (
          <div key={k.name} className={"pgc-line" + (k.teams.length ? "" : " coi-ancestor")} style={{ paddingLeft: 8 + depthOf(tree, k) * 14 }}>
            <code>└ {k.name}{k.teams.length ? "" : "  (kept as a parent)"}</code>
            <span className="coi-own">
              {k.own.map((f) => <span key={f} className={c.fixes[f] > 1 ? "copy" : ""} title={c.fixes[f] > 1 ? `${FNAME[f]} code is written in ${c.fixes[f]} classes` : undefined}>{FNAME[f].toLowerCase()}{c.fixes[f] > 1 ? " ×" : ""}</span>)}
            </span>
          </div>
        ))}
      </div>
      <dl className="pg-stats">
        <div className={c.classes > 3 ? "bad" : ""}><dt>Classes</dt><dd>{c.classes}</dd></div>
        <div className={c.copies ? "bad" : ""}><dt>Copied blocks</dt><dd>{c.copies}</dd></div>
        <div className={c.fixes.retry > 1 ? "bad" : ""}><dt>Fix retry bug</dt><dd>{n(c.fixes.retry, "edit")}</dd></div>
        <div className={c.fixes.logging > 1 ? "bad" : ""}><dt>Fix logging bug</dt><dd>{n(c.fixes.logging, "edit")}</dd></div>
      </dl>
    </section>
  );
}

function Composition({ st }: { st: State }) {
  const c = counts(st);
  const used = FEATURES.filter((f) => TEAMS.some((t) => st.teams[t.id].includes(f)));
  return (
    <section className="pg-side" aria-label="Composition design">
      <header><h4>Wrappers, stacked</h4></header>
      <p className="muted">One wrapper per feature. Each wraps any Transport. Teams stack what they need in main.</p>
      <div className="pgc">
        <div className="pgc-line file"><code>wrappers</code></div>
        {used.map((f) => <div key={f} className="pgc-line"><code>{FNAME[f]}(inner Transport)</code></div>)}
        <div className="pgc-line file"><code>main: one line per team</code></div>
        {TEAMS.map((t) => <div key={t.id} className="pgc-line"><code>{t.name.toLowerCase()} = {stackExpr(st.teams[t.id])}</code></div>)}
      </div>
      <dl className="pg-stats">
        <div><dt>Wrappers</dt><dd>{c.wrappers}</dd></div>
        <div><dt>Copied blocks</dt><dd>0</dd></div>
        <div><dt>Fix retry bug</dt><dd>1 edit</dd></div>
        <div><dt>Fix logging bug</dt><dd>1 edit</dd></div>
      </dl>
    </section>
  );
}

function StackLab({ st, dispatch, reduced }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void; reduced: boolean }) {
  const fs = st.teams[st.selected];
  const tr = st.trace;
  return (
    <div className="pg-card">
      <span className="label">Order matters: send one request through a team&apos;s stack</span>
      <PgChoice<TeamId> label="Team" value={st.selected} onChange={(t) => dispatch({ type: "select", team: t })} options={TEAMS.map((t) => ({ value: t.id, label: t.name }))} />
      <p className="muted coi-note">The server answers the first attempt with 503 and the second with 200. Move layers up (outside) or down (inside), then send.</p>
      <ol className="coi-stack" aria-label="Layers, outermost first">
        {fs.map((f, i) => (
          <li key={f} style={{ marginLeft: i * 12 }}>
            <code>{FNAME[f]}</code>
            <span className="coi-moves">
              <button className="pg-btn" onClick={() => dispatch({ type: "move", feature: f, dir: -1 })} disabled={i === 0} aria-label={`Move ${FNAME[f]} outward`}>↑</button>
              <button className="pg-btn" onClick={() => dispatch({ type: "move", feature: f, dir: 1 })} disabled={i === fs.length - 1} aria-label={`Move ${FNAME[f]} inward`}>↓</button>
            </span>
          </li>
        ))}
        <li style={{ marginLeft: fs.length * 12 }}><code>Http</code> <span className="muted">the real transport</span></li>
      </ol>
      <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "send" })}>Send GET /v1/charges</PgButton></div>
      {tr && (
        <>
          <div className="pg-log" aria-live="polite">
            {tr.hops.map((h, i) => (
              <div key={i} className={"pg-entry" + (h.bad ? " fail" : " ok") + (reduced ? "" : " fresh")} style={{ marginLeft: h.depth * 10 }}>
                <div className="pg-path" aria-hidden="true"><span style={{ animationDelay: `${i * 120}ms` }}>{h.text.split(":")[0]}</span></div>
                <p>{h.text.split(":").slice(1).join(":").trim()}</p>
              </div>
            ))}
          </div>
          <dl className="pg-stats">
            <div className={tr.status >= 500 ? "bad" : ""}><dt>Caller got</dt><dd>{tr.status}</dd></div>
            <div><dt>Log lines</dt><dd>{tr.logLines.length}</dd></div>
            <div><dt>Token fetches</dt><dd>{tr.tokenFetches}</dd></div>
            <div><dt>HTTP calls</dt><dd>{tr.httpCalls}</dd></div>
          </dl>
          <p className="pg-takeaway">{explain(tr) || "No layers: the caller saw the 503."}</p>
        </>
      )}
      <p className="muted coi-note">In the class tree you cannot do this: <code>Logging…Client.send</code> logs and then calls <code>super</code>, so its order was fixed the day the subclass was written.</p>
    </div>
  );
}

export default function CompositionPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<"1" | "4" | "8" | null>(null);
  const c = counts(st);

  return (
    <PgFrame title="Feature mixes: subclasses vs wrappers" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <div className="pg-req">
        <span className="label">Change request</span>
        <h3>Log every outgoing request</h3>
        <p>Security wants method, URL, status and latency logged for every HTTP call, from every team. Today three teams use three mixes of retry and auth, and Webhooks uses the plain client.</p>
        <div className="pg-actions">
          <PgButton primary disabled={st.loggingEverywhere} onClick={() => dispatch({ type: "logEverywhere" })}>{st.loggingEverywhere ? "Shipped" : "Ship it: add logging for every team"}</PgButton>
        </div>
      </div>

      <PgPredict
        question="With subclassing, how many new client classes does this request need?"
        options={[{ value: "1", label: "1" }, { value: "4", label: "4" }, { value: "8", label: "8" }]}
        value={guess}
        onChange={setGuess}
        revealed={st.loggingEverywhere}
        answer="4"
        explain={<>Every mix a team uses now needs a logging version: LoggingAuthRetryingClient, LoggingRetryingClient, LoggingAuthClient and LoggingClient. Each writes the logging code itself, because no parent has it. The old classes stay as parents. With wrappers, the whole request is one new Logging wrapper.</>}
      />

      <TeamGrid st={st} dispatch={dispatch} />

      <div className="pg-sides">
        <Inheritance st={st} />
        <Composition st={st} />
      </div>

      {st.before && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What the request cost</span>
          <p><b>Subclassing:</b> {n(st.before.classes, "class", "classes")} became {n(c.classes, "class", "classes")}, and copied feature blocks went from {st.before.copies} to {c.copies}. A bug in the logging code is now {n(c.fixes.logging, "edit")}.</p>
          <p><b>Wrappers:</b> one new Logging wrapper, and one changed line per team in main. Every feature is still written once.</p>
          <p className="pg-takeaway">A class per combination grows with the product of the features; wrappers grow with their sum. Toggle more features in the grid and watch the two counts part.</p>
        </div>
      )}

      <StackLab st={st} dispatch={dispatch} reduced={reduced} />

      <PgSources links={[
        { title: "Refactoring.Guru: Bridge (the class explosion)", href: "https://refactoring.guru/design-patterns/bridge" },
        { title: "Go net/http RoundTripper", href: "https://pkg.go.dev/net/http#RoundTripper" },
        { title: "Tower's Service and Layer", href: "https://docs.rs/tower/latest/tower/" },
      ]} />

      <style>{`
        .coi-grid { border-collapse: collapse; width: 100%; max-width: 520px; font-size: .9rem; }
        .coi-grid caption { text-align: left; padding-bottom: 6px; }
        .coi-grid th, .coi-grid td { border: 1px solid var(--line); padding: 3px 8px; text-align: center; background: var(--bg); }
        .coi-grid th[scope="row"] { text-align: left; }
        .coi-grid thead th { font-family: var(--f-code); font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .coi-cell { border: 0; background: transparent; font-size: 1rem; width: 100%; color: var(--ink-2); }
        .coi-cell.on { color: var(--accent); }
        .coi-tree .pgc-line { justify-content: space-between; }
        .coi-ancestor code { color: var(--ink-2); }
        .coi-own { display: flex; gap: 4px; flex-wrap: wrap; }
        .coi-own span { font-family: var(--f-code); font-size: .62rem; border: 1px solid var(--line); padding: 0 5px; background: var(--bg); }
        .coi-own span.copy { color: var(--pain); border-color: var(--pain); background: var(--pain-bg); }
        .coi-note { margin: 0; font-size: .9rem; }
        .coi-stack { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        .coi-stack li { border: 1px solid var(--line); background: var(--surface); padding: 3px 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; transition: margin-left .2s var(--ease); }
        .coi-moves { display: flex; gap: 4px; }
        .coi-moves .pg-btn { padding: 1px 8px; }
        @media (prefers-reduced-motion: reduce) { .coi-stack li { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
