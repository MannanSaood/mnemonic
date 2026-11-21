"use client";
import { useState } from "react";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUILDS, BUILD_NAME, PROBES, TENANT, counterfactual, goals, init, seedDb, step, totals,
  type Build, type Run, type Val,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const lit = (v: Val) => (typeof v === "string" ? `'${v}'` : String(v));

/* ---------------- the SQL text, coloured by where each character came from ---------------- */

function SqlText({ r }: { r: Run }) {
  if (r.status === 400) return <pre className="inj-sql"><span className="inj-muted">No SQL was built: the request was rejected first.</span></pre>;
  if (r.build === "param") {
    return (
      <div className="inj-param">
        <pre className="inj-sql" aria-label="Statement sent first">{r.sql}</pre>
        <div className="inj-bind" aria-label="Parameters sent separately">
          <span className="label">Sent separately, after the statement is parsed</span>
          {r.params.map((v, i) => <code key={i}>${i + 1} = <span className="inj-data">{lit(v)}</span></code>)}
        </div>
      </div>
    );
  }
  return (
    <pre className="inj-sql" aria-label="SQL text the database receives">
      {r.pieces.map((p, i) => (
        <span key={i} className={p.from === "template" ? (p.disabled ? "inj-off" : "") : `inj-${p.role}`}
          title={p.from === "template" ? (p.disabled ? "template text switched off by a comment" : "template") : `from ${p.from}: read as ${p.role === "ident" ? "the expected column name" : p.role}`}>
          {p.text}
        </span>
      ))}
    </pre>
  );
}

/* ---------------- the endpoint's response ---------------- */

function Response({ r }: { r: Run }) {
  const others = new Set(seedDb().customers.rows.filter((x) => x.tenant_id !== TENANT).map((x) => x.name));
  return (
    <div className="inj-resp">
      <span className={"inj-status s" + r.status}>HTTP {r.status}</span>
      {r.error ? (
        <pre className="inj-err">{`{"error": "${r.error}"}`}</pre>
      ) : r.rows.length === 0 ? (
        <p className="pg-empty">[] no rows</p>
      ) : (
        <div className="inj-table" role="region" aria-label="Rows returned" tabIndex={0}>
          <table>
            <thead><tr>{r.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {r.rows.map((row, i) => {
                const secret = Object.values(row).some((v) => typeof v === "string" && v.startsWith("$2b$"));
                const other = others.has(String(row.name));
                return (
                  <tr key={i} className={secret || other ? "bad" : ""}>
                    {r.columns.map((c) => <td key={c}>{String(row[c])}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(r.effects.deleted > 0 || r.effects.dropped.length > 0 || r.effects.updated > 0) && (
        <p className="inj-damage">Also ran: {[r.effects.deleted ? `DELETE ${r.effects.deleted}` : "", r.effects.updated ? `UPDATE ${r.effects.updated}` : "", ...r.effects.dropped.map((t) => `DROP TABLE ${t}`)].filter(Boolean).join(" · ")}</p>
      )}
    </div>
  );
}

function verdict(r: Run): string {
  if (r.status === 400) return "rejected: not an allowed sort";
  if (r.status === 500) return "error leaked to the client";
  const bad = [r.otherTenantRows ? `${r.otherTenantRows} other-tenant rows` : "", r.secretsRead ? `${r.secretsRead} password hashes` : "",
    r.effects.deleted ? `${r.effects.deleted} rows deleted` : "", r.effects.dropped.length ? "table dropped" : ""].filter(Boolean);
  return bad.length ? bad.join(", ") : `${n(r.rows.length, "row")}, as intended`;
}

/* ---------------- the reader's own result ---------------- */

function Result({ runs }: { runs: Run[] }) {
  const c = totals(runs, "concat"), e = totals(runs, "escape"), p = totals(runs, "param");
  const lines: string[] = [];
  const used = (b: Build) => runs.some((r) => r.build === b);
  if (used("concat"))
    lines.push(`In the concatenating build, ${n(c.codeChars, "character")} you typed became SQL syntax, which ran ${n(c.extraStatements, "statement")} the developer never wrote, returned ${n(c.otherTenantRows, "row")} from another tenant and ${n(c.secretsRead, "password hash", "password hashes")}, and deleted ${n(c.deleted, "row")}.`);
  if (used("escape"))
    lines.push(e.codeChars
      ? `Escaping quotes kept your quotes inside the string, yet ${n(e.codeChars, "character")} of the sort value still ran as SQL${e.dropped ? " and dropped a table" : ""}: no quote is needed where there is no string.`
      : "Escaping quotes kept every quote you typed inside the string. Now try the sort parameter.");
  if (used("param"))
    lines.push(`With parameters, nothing you typed entered the SQL text (${n(p.codeChars, "character")} read as SQL): the statement was parsed before your value arrived, so the value could only be a value, and the sort had to match the allow-list.`);
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G = "none" | "error" | "all" | "own";

export default function InjectionPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<G | null>(null);
  const r = st.runs[st.runs.length - 1] ?? null;
  const g = goals(st.runs);
  const cf = counterfactual(st);
  const revealed = st.runs.some((x) => x.build === "concat" && x.req.q.includes("1=1"));
  const reset = () => { setGuess(null); dispatch({ type: "reset" }); };
  const customers = st.db.customers?.rows.length;

  return (
    <PgFrame title="One search box, three ways to build the SQL" onReset={reset}>
      <PgPredict<G>
        question="The concatenating build. You search for  ' OR 1=1 --  instead of a name. What comes back?"
        options={[{ value: "none", label: "No rows: nobody is called that" }, { value: "error", label: "A syntax error" }, { value: "own", label: "All of my tenant's customers" }, { value: "all", label: "Every tenant's customers" }]}
        value={guess} onChange={setGuess} revealed={revealed} answer="all"
        explain={<>The quote closes the string literal, <code>OR 1=1</code> becomes part of the WHERE clause, and <code>--</code> comments out the rest. AND binds tighter than OR, so the tenant check is ORed away and every row matches, other companies&apos; customers included. Now switch to Parameters and send the same text.</>}
      />

      <div className="inj-controls">
        <div><span className="label">How the endpoint builds its SQL</span>
          <PgChoice<Build> label="Build" value={st.build} options={BUILDS.map((b) => ({ value: b, label: BUILD_NAME[b] }))} onChange={(b) => dispatch({ type: "build", build: b })} />
        </div>
        <form className="inj-req" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "send" }); }}>
          <span className="inj-verb">GET /api/customers?q=</span>
          <input aria-label="q parameter" value={st.q} onChange={(e) => dispatch({ type: "q", q: e.target.value })} spellCheck={false} />
          <span className="inj-verb">&amp;sort=</span>
          <input aria-label="sort parameter" className="inj-sort" value={st.sort} onChange={(e) => dispatch({ type: "sort", sort: e.target.value })} spellCheck={false} />
          <button type="submit" className="pg-btn primary">Send ▶</button>
        </form>
        <div className="inj-probes">
          <span className="label">Textbook probes (this fake database only)</span>
          <div className="pg-actions">
            {PROBES.map((p, i) => <button key={p.label} className="pg-btn inj-probe" title={p.note} onClick={() => dispatch({ type: "probe", index: i })}>{p.label}</button>)}
          </div>
        </div>
      </div>

      <div className="inj-grid">
        <div className="inj-panel">
          <span className="label">{r ? `Run ${r.n} · what the database receives` : "What the database receives"}</span>
          {r ? <SqlText key={r.n} r={r} /> : <p className="pg-empty">Send a request to see the SQL text.</p>}
          {r && r.build !== "param" && r.status !== 400 && (
            <p className="muted inj-legend"><span className="inj-data">your input read as data</span> · <span className="inj-code">your input read as SQL</span> · <span className="inj-ident">expected column name</span> · <span className="inj-off">switched off by a comment</span></p>
          )}
        </div>
        <div className="inj-panel">
          <span className="label">{r ? `Response to run ${r.n} (${BUILD_NAME[r.build]})` : "Response"}</span>
          {r ? <Response r={r} /> : <p className="pg-empty">Nothing sent yet.</p>}
        </div>
      </div>

      <div className="inj-cf" aria-live="polite">
        <span className="label">The text in the boxes now, sent to each build (dry run, nothing kept)</span>
        <div className="inj-cf-row">
          {cf.map((x) => (
            <div key={x.build} className={"inj-cf-card" + (x.build === st.build ? " cur" : "") + (x.codeChars > 0 ? " bad" : "") + (reduced ? "" : " anim")}>
              <b>{BUILD_NAME[x.build]}</b>
              <span>HTTP {x.status} · {n(x.codeChars, "char")} read as SQL</span>
              <span>{verdict(x)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="inj-db">
        <span className="label">The database</span>
        <span className={customers === undefined ? "bad" : customers < 8 ? "bad" : ""}>customers: {customers === undefined ? "table dropped" : `${customers} rows`}</span>
        <span>users: {st.db.users ? `${st.db.users.rows.length} rows` : "table dropped"}</span>
        <button className="pg-btn ghost" onClick={() => dispatch({ type: "restore" })}>Restore from backup</button>
      </div>

      {r && (
        <div className="pg-result">
          <span className="label">What your requests did</span>
          <Result runs={st.runs} />
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="inj-goals">
          <li className={g.otherTenant ? "done" : ""}>{g.otherTenant ? "✓" : "○"} Get another company&apos;s customers out of tenant 42&apos;s search.</li>
          <li className={g.secrets ? "done" : ""}>{g.secrets ? "✓" : "○"} Read the users table, which the endpoint never queries.</li>
          <li className={g.destroy ? "done" : ""}>{g.destroy ? "✓" : "○"} Destroy data with a search request. Then restore from backup.</li>
          <li className={g.escapeBroken ? "done" : ""}>{g.escapeBroken ? "✓" : "○"} Make your input run as SQL in the escaped build.</li>
          <li className={g.obrien ? "done" : ""}>{g.obrien ? "✓" : "○"} Find Siobhan O&apos;Brien with the parameterised build.</li>
        </ul>
      </div>

      <p className="muted inj-fine">A tiny SQL engine running in your browser on made-up data. Nothing is sent anywhere.</p>

      <PgSources links={[
        { title: "Hacksplaining's SQL injection lesson", href: "https://www.hacksplaining.com/exercises/sql-injection" },
        { title: "PortSwigger Web Security Academy", href: "https://portswigger.net/web-security/sql-injection" },
        { title: "bobby-tables.com", href: "https://bobby-tables.com/" },
      ]} />

      <style>{`
        .inj-controls { display: grid; gap: 10px; }
        .inj-controls > div { display: grid; gap: 4px; }
        .inj-req { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-family: var(--f-code); font-size: .82rem; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; }
        .inj-verb { color: var(--ink-2); }
        .inj-req input { font: inherit; flex: 1 1 200px; min-width: 0; border: 1px solid var(--line); background: var(--bg); color: var(--ink); padding: 3px 6px; }
        .inj-req input.inj-sort { flex: 0 1 140px; }
        .inj-req input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .inj-probe { font-family: var(--f-code); font-size: .74rem; padding: 2px 7px; }
        .inj-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        .inj-panel { border: 1px solid var(--line); background: var(--bg); padding: 8px; display: grid; gap: 8px; min-width: 0; }
        .inj-sql { white-space: pre-wrap; word-break: break-word; font-size: .8rem; margin: 0; padding: 6px 8px; background: var(--surface); border: 1px solid var(--line); }
        .inj-data { background: var(--good-bg); color: var(--good); box-shadow: inset 0 -2px 0 var(--good); }
        .inj-code { background: var(--pain-bg); color: var(--pain); font-weight: 700; box-shadow: inset 0 -2px 0 var(--pain); }
        .inj-comment { background: var(--pain-bg); color: var(--pain); font-style: italic; }
        .inj-ident { box-shadow: inset 0 -2px 0 var(--accent); }
        .inj-off { text-decoration: line-through; opacity: .5; }
        .inj-muted { color: var(--ink-2); }
        .inj-bind { display: grid; gap: 4px; border: 1px dashed var(--accent); padding: 6px 8px; font-size: .8rem; }
        .inj-bind code { white-space: pre-wrap; word-break: break-word; }
        .inj-param { display: grid; gap: 6px; }
        .inj-legend { font-size: .76rem; margin: 0; }
        .inj-resp { display: grid; gap: 6px; }
        .inj-status { font-family: var(--f-code); font-size: .78rem; font-weight: 700; }
        .inj-status.s200 { color: var(--good); } .inj-status.s400 { color: var(--accent); } .inj-status.s500 { color: var(--pain); }
        .inj-err { white-space: pre-wrap; word-break: break-word; font-size: .76rem; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); padding: 6px 8px; margin: 0; }
        .inj-table { overflow-x: auto; }
        .inj-table table { border-collapse: collapse; width: 100%; font-size: .74rem; font-family: var(--f-code); }
        .inj-table th, .inj-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; white-space: nowrap; }
        .inj-table th { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .inj-table tr.bad td { color: var(--pain); background: var(--pain-bg); }
        .inj-damage { margin: 0; font-family: var(--f-code); font-size: .78rem; color: var(--pain); font-weight: 700; }
        .inj-cf { display: grid; gap: 4px; }
        .inj-cf-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .inj-cf-card { border: 1px solid var(--line); border-left: 3px solid var(--good); padding: 6px 8px; display: grid; gap: 2px; font-size: .8rem; background: var(--surface); }
        .inj-cf-card.bad { border-left-color: var(--pain); background: var(--pain-bg); }
        .inj-cf-card.cur { outline: 2px solid var(--accent); outline-offset: -2px; }
        .inj-cf-card.anim { transition: background .2s var(--ease), border-color .2s var(--ease); }
        .inj-cf-card b { font-family: var(--f-code); font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; }
        .inj-db { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; font-family: var(--f-code); font-size: .8rem; }
        .inj-db .bad { color: var(--pain); font-weight: 700; }
        .inj-goals { list-style: none; padding-left: 0 !important; }
        .inj-goals li.done { color: var(--good); }
        .inj-fine { font-size: .76rem; }
        @media (max-width: 760px) { .inj-grid, .inj-cf-row { grid-template-columns: minmax(0, 1fr); } }
        @media (prefers-reduced-motion: reduce) { .inj-cf-card.anim { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
