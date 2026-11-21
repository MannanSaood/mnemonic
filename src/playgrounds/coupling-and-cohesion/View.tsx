"use client";
import { useState } from "react";
import { PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  API, CHANGEABLE, FACT, FACTS, MODULE, MODULES, SHORTCUTS, init, step, uses,
  type Design, type FactId, type ModuleId, type Ripple, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const pct = (r: Ripple) => Math.round((r.inOwner / r.places) * 100);

/** Which other modules' data a module reads directly, in the current design. */
function reachesInto(st: State, m: ModuleId): ModuleId[] {
  const owners = uses(st.design, st.shortcuts).filter((u) => u.module === m).map((u) => FACT[u.fact].owner).filter((o) => o !== m);
  return [...new Set(owners)];
}

function hopOf(r: Ripple | null, m: ModuleId): number | null {
  if (!r) return null;
  const hs = r.hits.filter((h) => h.module === m).map((h) => h.hop);
  return hs.length ? Math.min(...hs) : null;
}

function ModuleBox({ st, id, onChange, reduced }: { st: State; id: ModuleId; onChange: (f: FactId) => void; reduced: boolean }) {
  const m = MODULE[id];
  const hop = hopOf(st.current, id);
  const facts = FACTS.filter((f) => f.owner === id && CHANGEABLE.includes(f.id));
  const reach = reachesInto(st, id);
  const cls = "cc-mod" + (hop === 0 ? " origin" : hop === 1 ? " hop1" : hop !== null ? " hop2" : "");
  return (
    <div className={cls} style={!reduced && hop !== null ? { transitionDelay: `${hop * 260}ms` } : undefined}>
      <div className="cc-mod-head">
        <b>{m.name}</b>
        <span className="cc-team">{m.team} team</span>
      </div>
      <div className="cc-facts">
        {facts.map((f) => (
          <button key={f.id} className={"cc-fact" + (st.current?.fact === f.id ? " on" : "")} onClick={() => onChange(f.id)} aria-pressed={st.current?.fact === f.id} title={f.change}>
            change {f.label}
          </button>
        ))}
      </div>
      {st.design === "cohesive" ? (
        <p className="cc-api"><span className="label">Asks / answers</span> <code>{API[id]}</code></p>
      ) : null}
      {reach.length > 0 && <p className="cc-reach">Reaches into {reach.map((r) => MODULE[r].name).join(", ")}</p>}
      {hop !== null && <span className="cc-hop">{hop === 0 ? "changes first" : `must change · hop ${hop}`}</span>}
    </div>
  );
}

export default function CouplingPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<"1" | "2" | "3" | "4" | null>(null);
  const r = st.current;
  const stockDone = st.history.some((h) => h.fact === "stock");
  const tangledTotal = st.history.reduce((a, h) => a + h.tangled.modules.length, 0);
  const cohesiveTotal = st.history.reduce((a, h) => a + h.cohesive.modules.length, 0);

  return (
    <PgFrame
      title="Change one detail, watch the ripple"
      onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}
      toolbar={<PgChoice<Design> label="Design" value={st.design} onChange={(d) => dispatch({ type: "design", design: d })}
        options={[{ value: "tangled", label: "Tangled" }, { value: "cohesive", label: "Cohesive" }]} />}
    >
      <PgPredict
        question="A second warehouse opens, so Inventory keeps stock per warehouse. In the tangled design, how many modules must change?"
        options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]}
        value={guess}
        onChange={setGuess}
        revealed={stockDone}
        answer="3"
        explain={<>Inventory, plus every module that touches its stock map: Orders decrements it, Shipping reads it. In the cohesive design only Inventory changes, because the others ask <code>available</code> and <code>reserve</code> and never see the map. Click &quot;change stock map&quot; in either design to see it.</>}
      />

      <p className="pg-rule"><b>Click an internal detail to change it.</b> The owner changes first; every module that uses the detail changes next (hop 1); modules that use something computed from it follow (hop 2). Flip the design at the top to run the same change the other way.</p>

      <div className="cc-map" aria-live="polite">
        {MODULES.map((m) => <ModuleBox key={m.id} st={st} id={m.id} reduced={reduced} onChange={(f) => dispatch({ type: "change", fact: f })} />)}
      </div>

      {r ? (
        <div className="pg-grid">
          <div className="pg-card">
            <span className="label">The change</span>
            <p className="cc-req">{FACT[r.fact].change}</p>
            <dl className="pg-stats">
              <div className={r.modules.length > 1 ? "bad" : ""}><dt>Modules</dt><dd>{r.modules.length}</dd></div>
              <div className={r.places > 1 ? "bad" : ""}><dt>Places</dt><dd>{r.places}</dd></div>
              <div className={r.teams > 1 ? "bad" : ""}><dt>Teams</dt><dd>{r.teams}</dd></div>
              <div><dt>Edits in owner</dt><dd>{pct(r)}%</dd></div>
            </dl>
          </div>
          <div className="pg-card">
            <span className="label">Ripple, in order</span>
            <div className="pg-log">
              {r.hits.map((h, i) => (
                <div key={`${r.fact}-${st.design}-${i}`} className={"pg-entry" + (h.hop === 0 ? " ok" : " fail") + (reduced ? "" : " fresh")}>
                  <div className="pg-path" aria-hidden="true">
                    <span style={{ animationDelay: `${i * 160}ms` }}>hop {h.hop}</span>
                    <span style={{ animationDelay: `${i * 160 + 80}ms` }}>{MODULE[h.module].name}</span>
                  </div>
                  <p>{h.where}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="pg-empty">No change yet. Start with the stock map in Inventory.</p>
      )}

      {st.design === "cohesive" && (
        <div className="pg-card">
          <span className="label">Break it: take a shortcut</span>
          <p className="muted cc-note">Each shortcut saves someone a method call today. Turn one on, then repeat a change.</p>
          <div className="cc-shortcuts">
            {SHORTCUTS.map((s) => (
              <button key={s.id} className={"cc-short" + (st.shortcuts.includes(s.id) ? " on" : "")} aria-pressed={st.shortcuts.includes(s.id)} onClick={() => dispatch({ type: "shortcut", id: s.id })}>
                <span aria-hidden="true">{st.shortcuts.includes(s.id) ? "■" : "□"}</span> {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {st.history.length > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">Your changes, measured in both designs</span>
          <table className="cc-table">
            <thead><tr><th>Change</th><th>Tangled</th><th>Cohesive{st.shortcuts.length ? ` (+${n(st.shortcuts.length, "shortcut")})` : ""}</th></tr></thead>
            <tbody>
              {st.history.map((h) => (
                <tr key={h.fact}>
                  <td>{FACT[h.fact].label}</td>
                  <td>{n(h.tangled.modules.length, "module")}, {n(h.tangled.places, "place")}</td>
                  <td>{n(h.cohesive.modules.length, "module")}, {n(h.cohesive.places, "place")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pg-takeaway">
            Across your {n(st.history.length, "change")}, the tangled design touched {n(tangledTotal, "module")} and the cohesive one {n(cohesiveTotal, "module")}.{" "}
            {st.shortcuts.length
              ? "Every shortcut you turned on is a new reach-in, and the ripple grows back exactly along it."
              : "A change spreads along every place that knows a detail. Keep each detail inside the module that owns it, and expose questions instead of data, and the ripple stops at the owner."}
            {st.history.some((h) => h.tangled.modules.length === 1) ? " Some changes stayed local in both designs: coupling is about specific changes, not about modules in general." : ""}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Kent Beck: Coupling and Cohesion (Tidy First?)", href: "https://newsletter.kentbeck.com/p/coupling" },
        { title: "connascence.io", href: "https://connascence.io/" },
        { title: "CodeScene: change coupling", href: "https://codescene.io/docs/guides/technical/change-coupling.html" },
      ]} />

      <style>{`
        .cc-map { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 16px 16px; padding: 8px; border: 1px solid var(--line); }
        .cc-mod { border: 1px solid var(--line); background: var(--bg); padding: 8px 10px; display: grid; gap: 6px; align-content: start; min-width: 0; transition: border-color .25s var(--ease), background-color .25s var(--ease); }
        .cc-mod.origin { border: 2px solid var(--accent); }
        .cc-mod.hop1 { border: 2px solid var(--pain); background: var(--pain-bg); }
        .cc-mod.hop2 { border: 2px dashed var(--pain); background: var(--pain-bg); }
        .cc-mod-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
        .cc-mod-head b { font-family: var(--f-code); text-transform: uppercase; letter-spacing: .06em; font-size: .85rem; }
        .cc-team { font-size: .75rem; color: var(--ink-2); }
        .cc-facts { display: flex; flex-wrap: wrap; gap: 4px; }
        .cc-fact { border: 1px solid var(--line); background: var(--surface); font-family: var(--f-code); font-size: .68rem; padding: 2px 6px; }
        .cc-fact.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
        .cc-api, .cc-reach { margin: 0; font-size: .8rem; }
        .cc-api code { font-size: .68rem; }
        .cc-reach { color: var(--pain); }
        .cc-hop { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--pain); }
        .cc-mod.origin .cc-hop { color: var(--accent); }
        .cc-req { margin: 0; }
        .cc-note { margin: 0; font-size: .9rem; }
        .cc-shortcuts { display: grid; gap: 4px; }
        .cc-short { text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 4px 8px; font-size: .88rem; }
        .cc-short.on { border-color: var(--pain); color: var(--pain); }
        .cc-table { border-collapse: collapse; width: 100%; font-size: .9rem; }
        .cc-table th, .cc-table td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
        .cc-table th { font-family: var(--f-code); font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        @media (max-width: 720px) { .cc-map { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 420px) { .cc-map { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .cc-mod { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
