"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  COLS, indexName, init, PRESETS, ROWS, step, TABLE_PAGES,
  type Action, type Challenge, type Col, type Engine, type Run, type State, type Use,
} from "./model";

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "tight", title: "Read exactly as many index entries as rows returned, using two columns", note: "every condition was an access predicate, so the scan started and stopped on matching entries" },
  { id: "rangeFirst", title: "Read 20x more index entries than rows returned", note: "a range on the first column spreads the second column's matches across the whole range" },
  { id: "function", title: "Lose the index by wrapping its leading column in a function", note: "the index stores created_at, not date(created_at), so nothing in it is sorted by what you compare" },
  { id: "giveUp", title: "Make the planner pick a full scan although the index matches the condition", note: "when most rows match, fetching them one by one through the index costs more than reading the table in order" },
  { id: "skip", title: "Use an index without a condition on its leading column (PostgreSQL 18)", note: "skip scan searches the index once per leading value, which pays off only when there are few" },
];

const n = (k: number) => k.toLocaleString("en");
const USE_LABEL: Record<Use, string> = { access: "access", skip: "skip", "index filter": "index filter", "table filter": "table filter" };

function Strip({ r }: { r: Run }) {
  const max = Math.max(1, ...r.bins.map((b) => b.scanned));
  const used = r.plan === "index";
  const labels = [0, 25, 50, 75].map((b) => ({ at: b, text: r.binLabels[b] }));
  return (
    <div className={"ix-strip" + (used ? "" : " unused")} aria-hidden="true">
      <div className="ix-bars">
        {r.bins.map((b, i) => (
          <span key={i} className={b.scanned ? "scan" : ""} style={{ height: `${b.scanned ? 18 + (82 * b.scanned) / max : 6}%` }}>
            {b.returned > 0 && <i style={{ height: `${Math.max(8, (100 * b.returned) / Math.max(1, b.scanned))}%` }} />}
          </span>
        ))}
      </div>
      <div className="ix-axis">
        {labels.map((l) => <span key={l.at} style={{ left: `${l.at}%` }}>{r.index[0] ?? ""} {l.text}</span>)}
      </div>
    </div>
  );
}

function Lane({ st, lane, dispatch }: { st: State; lane: 0 | 1; dispatch: (a: Action) => void }) {
  const cols = st.indexes[lane];
  const r = st.runs?.[lane];
  const name = lane === 0 ? "A" : "B";
  return (
    <div className="pg-side">
      <header><h4>Index {name}</h4><code className="ix-ddl">ON orders {indexName(cols)}</code></header>
      <div className="ix-cols">
        {cols.map((c, i) => (
          <span key={c} className="ix-col">
            <b>{i + 1}. {c}</b>
            <button onClick={() => dispatch({ type: "moveCol", lane, at: i, dir: -1 })} disabled={i === 0} aria-label={`Move ${c} earlier in index ${name}`}>←</button>
            <button onClick={() => dispatch({ type: "moveCol", lane, at: i, dir: 1 })} disabled={i === cols.length - 1} aria-label={`Move ${c} later in index ${name}`}>→</button>
            <button onClick={() => dispatch({ type: "removeCol", lane, at: i })} aria-label={`Remove ${c} from index ${name}`}>×</button>
          </span>
        ))}
        {COLS.filter((c) => !cols.includes(c)).map((c) => (
          <button key={c} className="ix-add" onClick={() => dispatch({ type: "addCol", lane, col: c })} aria-label={`Add ${c} to index ${name}`}>+ {c}</button>
        ))}
      </div>
      {!r && <p className="pg-empty">Run a query to see which part of this index it reads.</p>}
      {r && (
        <>
          <Strip r={r} />
          <ul className="ix-preds" aria-label="How each condition uses the index">
            {r.skipCol && <li className="skip"><code>{r.skipCol}: every value</code><span>skip scan, {r.descents} descents</span></li>}
            {r.uses.map((u, i) => <li key={i} className={u.use.replace(" ", "-")}><code>{u.pred.text}</code><span>{USE_LABEL[u.use]}</span></li>)}
          </ul>
          <p className={"ix-plan " + r.plan} aria-live="polite">
            {r.plan === "index"
              ? <><b>Index scan.</b> Reads {n(r.entriesScanned)} index entries ({n(r.leafPages)} leaf pages), fetches {n(r.fetched)} rows from {n(r.heapPages)} table pages, returns {n(r.returned)}.</>
              : r.accessCols.length || r.skipCol
                ? <><b>Seq scan.</b> The index could narrow the scan to {n(r.entriesScanned)} entries, but fetching {n(r.fetched)} rows through it costs {Math.round(r.costIndex)} against {Math.round(r.costSeq)} for reading all {n(TABLE_PAGES)} table pages in order.</>
                : <><b>Seq scan.</b> No condition limits this index, so it cannot narrow anything. The planner reads all {n(TABLE_PAGES)} table pages and checks {n(ROWS)} rows.</>}
          </p>
          <dl className="pg-stats ix-stats">
            <div className={r.plan === "index" && r.entriesScanned > 5 * Math.max(1, r.returned) ? "bad" : ""}><dt>Entries read</dt><dd>{r.plan === "index" ? n(r.entriesScanned) : "-"}</dd></div>
            <div className={r.examined > 5 * Math.max(1, r.returned) ? "bad" : ""}><dt>Rows examined</dt><dd>{n(r.examined)}</dd></div>
            <div><dt>Rows returned</dt><dd>{n(r.returned)}</dd></div>
            <div className={r.plan === "seq" ? "bad" : ""}><dt>Pages read</dt><dd>{n(r.pagesRead)}</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}

type Guess = "same" | "a" | "b";

export default function IndexDesignPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const runs = st.runs;
  const last = st.history;

  return (
    <PgFrame title="Two composite indexes, one WHERE clause" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="orders has 100,000 rows from one year and 50 tenants. The query is tenant_id = 7 AND created_at >= '2026-12-01'. Index A is (created_at, tenant_id), index B is (tenant_id, created_at). Which reads fewer index entries?"
        options={[
          { value: "same", label: "The same: both columns are in both" },
          { value: "b", label: "B, by a lot" },
          { value: "a", label: "A, the date range is narrow" },
        ]}
        value={guess} onChange={setGuess} revealed={!!runs} answer="b"
        explain={<>In B, all of tenant 7's entries sit together, sorted by date, so the scan starts at tenant 7's first December entry and stops at its last. In A, the entries are sorted by date first, so December holds every tenant's orders mixed together, and the scan has to read all of them and check tenant_id on each. Equality columns first, then the range.</>}
      />

      <div className="pg-req">
        <span className="label">Query</span>
        <form className="ix-query" onSubmit={(e) => { e.preventDefault(); dispatch({ type: "run" }); }}>
          <label htmlFor="ix-where"><code>SELECT * FROM orders WHERE</code></label>
          <input id="ix-where" value={st.draft} spellCheck={false} autoComplete="off" onChange={(e) => dispatch({ type: "draft", text: e.target.value })} />
          <PgButton primary onClick={() => dispatch({ type: "run" })}>Run</PgButton>
        </form>
        {st.parsed.error && <p className="ix-err" role="alert">{st.parsed.error}</p>}
        <div className="ix-presets">
          <span className="pg-place">Try</span>
          {PRESETS.map((p) => <button key={p} className="ix-preset" onClick={() => dispatch({ type: "run", text: p })}>{p}</button>)}
        </div>
        <div className="ix-engine">
          <span className="pg-place">Engine</span>
          <PgChoice<Engine> label="PostgreSQL version" value={st.engine} onChange={(engine) => dispatch({ type: "engine", engine })}
            options={[{ value: "pg17", label: "PostgreSQL 17" }, { value: "pg18", label: "PostgreSQL 18 (skip scan)" }]} />
        </div>
        <p className="muted">Columns: tenant_id (50 tenants), status (new, paid, shipped, cancelled; most are shipped), created_at (dates in 2026), total_cents. Edit an index with the arrows; the query reruns.</p>
      </div>

      <div className="pg-sides">
        <Lane st={st} lane={0} dispatch={dispatch} />
        <Lane st={st} lane={1} dispatch={dispatch} />
      </div>
      <p className="muted ix-legend">
        Each strip is the whole index in key order. Teal bars: entries the scan reads. Green: entries that end up in the result.
        <span className="ix-key access">access</span> sets where the scan starts and stops, <span className="ix-key index-filter">index filter</span> is checked in the index, <span className="ix-key table-filter">table filter</span> needs the row.
      </p>

      {last.length > 0 && (
        <div className="pg-req">
          <span className="label">Your queries</span>
          <table className="ix-hist">
            <thead><tr><th>WHERE</th><th>A: rows examined → returned</th><th>B: rows examined → returned</th></tr></thead>
            <tbody>
              {last.map((h) => (
                <tr key={h.query}>
                  <td><code>{h.query}</code></td>
                  {h.runs.map((r, i) => <td key={i} className={r.plan}>{r.plan === "index" ? `${n(r.examined)} → ${n(r.returned)}` : `seq ${n(ROWS)} → ${n(r.returned)}`}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="ix-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {runs && last.length >= 3 && (() => {
        const all = last.flatMap((h) => h.runs.map((r) => ({ q: h.query, r })));
        const worst = all.reduce((x, y) => (y.r.examined / Math.max(1, y.r.returned) > x.r.examined / Math.max(1, x.r.returned) ? y : x));
        const best = all.filter((x) => x.r.plan === "index").reduce<typeof worst | null>((x, y) => (!x || y.r.examined / Math.max(1, y.r.returned) < x.r.examined / Math.max(1, x.r.returned) ? y : x), null);
        return (
          <div className="pg-result" aria-live="polite">
            <span className="label">What your queries showed</span>
            <p>
              You ran {last.length} queries against two indexes. The worst plan examined {n(worst.r.examined)} rows to return {n(worst.r.returned)} ({worst.r.plan === "seq" ? "a full table scan" : `index ${indexName(worst.r.index)}`}, for <code>{worst.q}</code>).
              {best && <> The best examined {n(best.r.examined)} rows to return {n(best.r.returned)}, with index {indexName(best.r.index)}.</>}
            </p>
            <p className="pg-takeaway">
              An index is one list sorted by its columns in order. A query can only seek on a prefix of that order: equality on the leading columns, then one range. Everything after the range, and anything wrapped in a function, is checked row by row. And when a condition matches a large share of the table, reading the table in order beats the index.
            </p>
          </div>
        );
      })()}

      <PgSources links={[
        { title: "Use The Index, Luke: the WHERE clause", href: "https://use-the-index-luke.com/sql/where-clause" },
        { title: "PostgreSQL docs on multicolumn indexes", href: "https://www.postgresql.org/docs/current/indexes-multicolumn.html" },
        { title: "explain.dalibo.com plan visualiser", href: "https://explain.dalibo.com/" },
      ]} />

      <style>{`
        .ix-query { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
        .ix-query input { font-family: var(--f-code); font-size: .82rem; padding: 5px 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); min-width: 0; }
        .ix-err { color: var(--pain); font-size: .9rem; }
        .ix-presets, .ix-engine { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
        .ix-preset { font-family: var(--f-code); font-size: .68rem; border: 1px solid var(--line); background: var(--surface); color: var(--ink); padding: 2px 6px; text-align: left; }
        .ix-ddl { font-size: .68rem; overflow-wrap: anywhere; }
        .ix-cols { display: flex; flex-wrap: wrap; gap: 4px; }
        .ix-col { display: inline-flex; align-items: center; border: 1px solid var(--accent); background: var(--surface); }
        .ix-col b { font-family: var(--f-code); font-size: .68rem; padding: 2px 6px; font-weight: 600; }
        .ix-col button { border: 0; border-left: 1px solid var(--line); background: transparent; color: var(--ink); padding: 2px 6px; font-size: .75rem; }
        .ix-col button:disabled { opacity: .35; }
        .ix-add { border: 1px dashed var(--line); background: transparent; color: var(--ink-2); font-family: var(--f-code); font-size: .68rem; padding: 2px 6px; }
        .ix-strip { display: grid; gap: 2px; }
        .ix-bars { display: flex; align-items: flex-end; height: 56px; gap: 1px; border-bottom: 1px solid var(--line); background-image: linear-gradient(var(--grid) 1px, transparent 1px); background-size: 100% 14px; }
        .ix-bars span { flex: 1; position: relative; background: var(--line); display: flex; align-items: flex-end; min-width: 0; }
        .ix-bars span.scan { background: var(--accent); opacity: .85; }
        .ix-bars span i { display: block; width: 100%; background: var(--good); }
        .ix-strip.unused .ix-bars span.scan { background: var(--ink-2); opacity: .4; }
        .ix-axis { position: relative; height: 14px; overflow: hidden; }
        .ix-axis span { position: absolute; font-family: var(--f-code); font-size: .55rem; color: var(--ink-2); white-space: nowrap; }
        .ix-preds { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
        .ix-preds li { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; border-left: 3px solid var(--line); padding: 1px 6px; font-size: .78rem; }
        .ix-preds li span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; }
        .ix-preds li.access, .ix-key.access { border-left-color: var(--accent); }
        .ix-preds li.skip { border-left-color: var(--accent); border-left-style: dashed; }
        .ix-preds li.index-filter, .ix-key.index-filter { border-left-color: var(--ink-2); }
        .ix-preds li.table-filter, .ix-key.table-filter { border-left-color: var(--pain); }
        .ix-key { border-left: 3px solid; padding: 0 4px; margin: 0 2px; font-family: var(--f-code); font-size: .7rem; }
        .ix-plan { margin: 0; font-size: .88rem; padding: 4px 8px; border-left: 3px solid var(--good); background: var(--good-bg); }
        .ix-plan.seq { border-left-color: var(--pain); background: var(--pain-bg); }
        .ix-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .ix-legend { font-size: .85rem; }
        .ix-hist { width: 100%; border-collapse: collapse; font-size: .8rem; }
        .ix-hist th { text-align: left; font-family: var(--f-code); font-size: .6rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
        .ix-hist td, .ix-hist th { border-bottom: 1px solid var(--line); padding: 3px 6px 3px 0; vertical-align: top; }
        .ix-hist td code { font-size: .68rem; overflow-wrap: anywhere; }
        .ix-hist td.seq { color: var(--pain); }
        .ix-hist td.index { font-family: var(--f-code); font-size: .72rem; }
        .ix-list { list-style: none; padding-left: 0 !important; }
        .ix-list li.got { color: var(--good); }
        @media (max-width: 520px) { .ix-query { grid-template-columns: 1fr auto; } .ix-query label { grid-column: 1 / -1; } .ix-stats { grid-template-columns: 1fr 1fr; } }
      `}</style>
    </PgFrame>
  );
}
