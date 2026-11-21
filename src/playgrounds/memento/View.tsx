"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHECKPOINT_EVERY, SIZES, fmtBytes, init, memory, sharesLive, step, valueOf,
  type Mismatch, type Side, type State, type Storage,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

const SIDE_INFO: Record<Side, { title: string; sub: string }> = {
  tool: { title: "Deploy tool copies fields", sub: "The rollback code reads the config's fields and saves them itself." },
  memento: { title: "Config hands out a memento", sub: "The config fills an opaque snapshot itself; the tool only stores it." },
};

const CHALLENGES = [
  { id: "route", title: "Change a route's upstream, then roll back", note: "the tool's snapshot was the live map, so the change stayed" },
  { id: "timeout", title: "Change only the timeout, then roll back", note: "a plain number is copied by value, so this works in both. This is the case the tool's tests covered" },
  { id: "limit", title: "Ship rate limits, change one, roll back", note: "the tool never heard of the new field, so it never saved it" },
] as const;

function Config({ st, d, wrong }: { st: State; d: Side; wrong: Mismatch[] }) {
  const v = valueOf(st, st[d].live);
  const bad = new Set(wrong.map((m) => m.key));
  return (
    <div className="pgc">
      <div className="pgc-line file"><code>live config · routes in map #{st[d].live.routes}</code></div>
      {Object.entries(v.routes).sort().map(([p, up]) => (
        <div key={p} className={"pgc-line" + (bad.has(p) || bad.has(`limit ${p}`) ? " bad" : "")}><code>{p.padEnd(9)} → {up}{v.limits?.[p] ? `   ${v.limits[p]}/s` : ""}</code></div>
      ))}
      {[...bad].filter((k) => k.startsWith("/") && !(k in v.routes)).map((k) => (
        <div key={k} className="pgc-line bad"><code>{k.padEnd(9)} (missing)</code></div>
      ))}
      <div className={"pgc-line" + (bad.has("timeout") ? " bad" : "")}><code>timeout   {v.timeout}s</code></div>
    </div>
  );
}

function History({ st, d }: { st: State; d: Side }) {
  const h = st[d].history;
  if (!h.length) return <p className="pg-empty">No snapshots yet. Each change saves one first.</p>;
  return (
    <ol className="memento-stack" reversed>
      {h.map((s, i) => {
        const shared = sharesLive(st, d, i);
        return (
          <li key={i} className={shared ? "shared" : ""}>
            <code>before “{s.label}”</code>
            <span>routes → map #{s.routes}{shared ? " · same map as live" : " · own copy"}</span>
            <span>timeout {s.timeout}s · limits {s.limits ? "saved" : st.limitsShipped ? "not saved" : "n/a"}</span>
          </li>
        );
      }).reverse()}
    </ol>
  );
}

function RollbackNote({ list }: { list: Mismatch[] }) {
  if (!list.length) return <p className="memento-ok">Restored exactly what was there.</p>;
  return (
    <div className="pg-entry fail">
      <p>Restored the wrong config:</p>
      {list.map((m) => <p key={m.key}><code>{m.key}</code> should be {m.expected}, is {m.got}</p>)}
    </div>
  );
}

type Guess = "v1" | "v2" | "error";

export default function MementoPlayground() {
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const live = valueOf(st, st.memento.live);
  const revealed = st.done.includes("route");
  const histLen = st.memento.history.length;
  const nEntries = Math.max(st.edits, 1);
  const rows: { id: Storage; label: string }[] = [
    { id: "snapshot", label: "Full snapshot per change" },
    { id: "diff", label: "Diff per change" },
    { id: "checkpoint", label: `Snapshot every ${CHECKPOINT_EVERY}, diffs between` },
  ];
  const mems = rows.map((r) => ({ ...r, ...memory(nEntries, st.size, r.id) }));
  const maxBytes = Math.max(...mems.map((m) => m.bytes), 1);

  return (
    <PgFrame title="Gateway config with rollback, built two ways" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="You switch /api from api-v1 to api-v2, then press Roll back. What does the deploy tool's own snapshot put back?"
        options={[
          { value: "v1", label: "api-v1, as before" },
          { value: "v2", label: "Nothing: /api stays on api-v2" },
          { value: "error", label: "The rollback fails with an error" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="v2"
        explain={<>The tool saved <code>Routes: cfg.Routes</code>, which copies a reference to the map, not the map. The edit changed that one map in place, so the snapshot changed with it. Only the config knows its routes must be cloned, which is why the config should make the snapshot.</>}
      />

      <div className="pg-req">
        <span className="label">Change the live config · both designs get every change</span>
        <ul className="pg-places">
          {Object.entries(live.routes).sort().map(([p, up]) => (
            <li key={p}>
              <span className="pg-place">{p}</span>
              <div className="pg-actions">
                <PgButton onClick={() => dispatch({ type: "setUpstream", path: p })} title="Point this route at the next version">{up} → next</PgButton>
                {st.limitsShipped && <PgButton onClick={() => dispatch({ type: "setLimit", path: p })}>limit {live.limits?.[p] ?? 100}/s → ×2</PgButton>}
              </div>
              <PgButton onClick={() => dispatch({ type: "removeRoute", path: p })} disabled={Object.keys(live.routes).length <= 1}>Remove</PgButton>
            </li>
          ))}
        </ul>
        <div className="pg-actions">
          <PgButton onClick={() => dispatch({ type: "addRoute" })}>+ route</PgButton>
          <PgButton onClick={() => dispatch({ type: "timeout", delta: -5 })}>timeout −5s</PgButton>
          <PgButton onClick={() => dispatch({ type: "timeout", delta: 5 })}>timeout +5s</PgButton>
          {!st.limitsShipped && <PgButton onClick={() => dispatch({ type: "shipLimits" })} title="The config team adds a field; the deploy tool is in another repo">Change request: add rate limits</PgButton>}
          <PgButton primary onClick={() => dispatch({ type: "rollback" })} disabled={!histLen}>Roll back {histLen ? `“${st.memento.history[histLen - 1].label}”` : ""}</PgButton>
        </div>
      </div>

      <div className="pg-sides">
        {(["tool", "memento"] as Side[]).map((d) => (
          <section key={d} className="pg-side" aria-label={SIDE_INFO[d].title}>
            <header>
              <h4>{SIDE_INFO[d].title}</h4>
              <span className={"pg-status" + (st[d].wrong ? "" : " done")}>{st[d].rollbacks ? `${st[d].rollbacks - st[d].wrong} of ${st[d].rollbacks} rollbacks right` : ""}</span>
            </header>
            <p className="muted memento-small">{SIDE_INFO[d].sub}</p>
            <Config st={st} d={d} wrong={st.last ? st.last[d] : []} />
            {st.last && (
              <div aria-live="polite">
                <span className="label">Rolled back “{st.last.label}”</span>
                <RollbackNote list={st.last[d]} />
              </div>
            )}
            <span className="label">History, newest first</span>
            <History st={st} d={d} />
          </section>
        ))}
      </div>

      <div className="pg-req">
        <span className="label">Break it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="memento-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      <div className="pg-req">
        <span className="label">What the history costs in production</span>
        <p className="memento-small">Your session has {n(nEntries, "change")}. Pick how many routes the real gateway config has:</p>
        <PgChoice label="Routes in production" value={String(st.size)} options={SIZES.map((s) => ({ value: String(s), label: s.toLocaleString("en-US") }))}
          onChange={(v) => dispatch({ type: "size", size: Number(v) })} />
        <div className="memento-mem">
          {mems.map((m) => (
            <div key={m.id}>
              <span className="pg-place">{m.label}</span>
              <span className="memento-bar"><i style={{ width: `${Math.max(1, (m.bytes / maxBytes) * 100)}%` }} /></span>
              <code>{fmtBytes(m.bytes)} · restore oldest in {n(m.worstRestore, "step")}</code>
            </div>
          ))}
        </div>
        <p className="memento-small muted">Estimates: about 80 bytes per route, 160 per diff record. A diff restore replays every step in order, and one bad diff breaks every restore behind it.</p>
      </div>

      {st.edits > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your session showed</span>
          <p>
            You made {n(st.edits, "change")} and {n(st.memento.rollbacks, "rollback")}. The deploy tool restored {st.tool.rollbacks - st.tool.wrong} of them correctly; the memento restored {st.memento.rollbacks - st.memento.wrong}.
            {" "}With {st.size.toLocaleString("en-US")} routes, your history costs {fmtBytes(mems[0].bytes)} as full snapshots and {fmtBytes(mems[1].bytes)} as diffs.
          </p>
          <p className="pg-takeaway">
            {st.tool.wrong > 0
              ? "A snapshot taken from outside copies what the outsider can see, in the way the outsider guesses. The config knows which fields exist and which must be cloned, so it should make the snapshot and keep it opaque. Whether to store snapshots or diffs is then a private decision of the config, traded between memory and restore steps."
              : "So far every rollback matched. Change a route and roll back to see what an outside copy really saved."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "refactoring.guru on Memento", href: "https://refactoring.guru/design-patterns/memento" },
        { title: "the University of Waterloo CS 349 lecture on undo", href: "https://student.cs.uwaterloo.ca/~cs349/1251/schedule/15-Undo.pdf" },
        { title: "Rethinking undo/redo (Travels)", href: "https://unadlib.github.io/2025/10/05/rethinking-undo-redo-why-we-need-travels/" },
      ]} />

      <style>{`
        .memento-small { font-size: .9rem; margin: 0; }
        .memento-stack { margin: 0; padding-left: 1.6em; display: grid; gap: 4px; max-height: 220px; overflow: auto; }
        .memento-stack li { border-left: 3px solid var(--good); background: var(--surface); padding: 3px 8px; display: grid; font-size: .8rem; }
        .memento-stack li.shared { border-left-color: var(--pain); background: var(--pain-bg); }
        .memento-stack li code { font-size: .72rem; }
        .memento-stack li span { color: var(--ink-2); font-family: var(--f-code); font-size: .66rem; }
        .memento-stack li.shared span:first-of-type { color: var(--pain); }
        .memento-ok { margin: 0; color: var(--good); font-size: .95rem; }
        .memento-list { list-style: none; padding-left: 0 !important; }
        .memento-list li.got { color: var(--good); }
        .memento-mem { display: grid; gap: 8px; }
        .memento-mem > div { display: grid; grid-template-columns: minmax(0, 14em) minmax(0, 1fr); gap: 4px 10px; align-items: center; }
        .memento-mem code { grid-column: 1 / -1; font-size: .72rem; }
        .memento-bar { height: 10px; border: 1px solid var(--line); background: var(--surface); display: block; }
        .memento-bar i { display: block; height: 100%; background: var(--accent); transition: width .3s var(--ease); }
        @media (prefers-reduced-motion: reduce) { .memento-bar i { transition: none; } }
        @media (max-width: 520px) { .memento-mem > div { grid-template-columns: 1fr; } }
      `}</style>
    </PgFrame>
  );
}
