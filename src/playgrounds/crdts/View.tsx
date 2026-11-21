"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ITEMS, NODES, NODE_NAMES, SLOTS,
  converged, eggs, init, items, laws, resurrected, same, step, tags, tombstones,
  type Action, type Challenge, type NodeId, type Replica, type State,
} from "./model";

const IDS: NodeId[] = [0, 1, 2];
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const vec = (v: number[]) => `[${v.join(",")}]`;

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "concurrent-inc", title: "Tap +1 on two replicas, then sync them", note: "the PN-Counter keeps each replica's taps in its own entry, so none is lost" },
  { id: "resurrect", title: "Remove an item that another replica has, then sync it back", note: "the naive union brings it back; the OR-Set's tombstone keeps it removed" },
  { id: "add-wins", title: "Remove an item on one replica while another re-adds it, then sync", note: "the remove only killed the tags it had seen; the new tag survives" },
  { id: "lww-lost", title: "Pick different delivery slots on two replicas, then sync", note: "LWW converges by throwing one pick away, with no error" },
  { id: "negative", title: "Make the egg count negative", note: "each replica checked ≥ 0 locally; only coordination can keep a global bound" },
];

function ReplicaCard({ st, i, dispatch }: { st: State; i: NodeId; dispatch: (a: Action) => void }) {
  const r = st.nodes[i];
  const list = items(r);
  const missing = ITEMS.filter((e) => !list.includes(e)).slice(0, 4);
  const back = resurrected(r);
  const naiveOff = r.naive.eggs !== eggs(r);
  const agrees = IDS.filter((j) => j !== i && same(st.nodes[j].doc, r.doc));
  const dead = new Set(r.doc.items.removed);
  return (
    <section className="pg-side cr-node" aria-label={NODE_NAMES[i]}>
      <header><h4>{NODE_NAMES[i]}</h4><span className="cr-small muted">{agrees.length ? `same as ${agrees.map((j) => NODES[j]).join(", ")}` : "differs from the others"}</span></header>

      <div className="cr-field">
        <span className="label">Delivery slot · LWW-Register</span>
        <PgChoice label={`Delivery slot on ${NODE_NAMES[i]}`} value={r.doc.slot.value} options={SLOTS.map((s) => ({ value: s, label: s }))}
          onChange={(v) => dispatch({ type: "slot", node: i, value: v })} />
        <code className="cr-meta">stamp (L{r.doc.slot.ts[0]}, {NODES[r.doc.slot.ts[1]]})</code>
      </div>

      <div className="cr-field">
        <span className="label">Eggs · PN-Counter</span>
        <div className="cr-count">
          <button className="pg-btn" onClick={() => dispatch({ type: "dec", node: i })} disabled={eggs(r) <= 0} aria-label={`One egg fewer on ${NODE_NAMES[i]}`}>−</button>
          <b className={eggs(r) < 0 ? "cr-neg" : ""} aria-live="polite">{eggs(r)}</b>
          <button className="pg-btn" onClick={() => dispatch({ type: "inc", node: i })} aria-label={`One egg more on ${NODE_NAMES[i]}`}>+</button>
        </div>
        <code className="cr-meta">P {vec(r.doc.eggs.p)} − N {vec(r.doc.eggs.n)}</code>
      </div>

      <div className="cr-field">
        <span className="label">List · OR-Set</span>
        <ul className="cr-list">
          {list.map((e) => (
            <li key={e}>
              <span>{e}</span>
              <button className="cr-x" onClick={() => dispatch({ type: "remove", node: i, item: e })} aria-label={`Remove ${e} on ${NODE_NAMES[i]}`}>×</button>
            </li>
          ))}
          {list.length === 0 && <li className="muted">empty</li>}
        </ul>
        <div className="cr-chips">
          {missing.map((e) => <button key={e} className="cr-chip" onClick={() => dispatch({ type: "add", node: i, item: e })}>+ {e}</button>)}
        </div>
        <code className="cr-meta">
          tags {r.doc.items.adds.map((t) => <span key={t.tag} className={dead.has(t.tag) ? "cr-dead" : ""}>{t.tag}:{t.e.split(" ")[0]} </span>)}
        </code>
      </div>

      <p className={"cr-naive" + (naiveOff || back.length ? " off" : "")}>
        Naive merge would show {r.naive.eggs} eggs{naiveOff ? ` (not ${eggs(r)})` : ""}
        {back.length ? `, and ${back.join(", ")} back on the list` : ""}.
      </p>

      <div className="pg-actions">
        {IDS.filter((j) => j !== i).map((j) => <PgButton key={j} onClick={() => dispatch({ type: "sync", from: i, to: j })} title={`Send ${NODES[i]}'s whole state to ${NODES[j]}, which merges it`}>Sync to {NODES[j]}</PgButton>)}
      </div>
    </section>
  );
}

function Laws({ st }: { st: State }) {
  const l = laws(st);
  const a = eggs(st.nodes[0]);
  const row = (ok: boolean, name: string, rule: string) => (
    <li className={ok ? "ok" : "bad"}><span aria-hidden="true">{ok ? "✓" : "✗"}</span> <b>{name}</b> <span className="muted">{rule}</span></li>
  );
  return (
    <div className="pg-card">
      <span className="label">Merge laws, checked on your three replicas right now</span>
      <ul className="cr-laws">
        {row(l.commutative, "Commutative", "merge(A, B) = merge(B, A): sync order between two replicas does not matter")}
        {row(l.associative, "Associative", "merge(merge(A, B), C) = merge(A, merge(B, C)): grouping does not matter")}
        {row(l.idempotent, "Idempotent", "merge(A, A) = A: a repeated or duplicated sync changes nothing")}
        {row(false, "Counter merge that adds the counts", `merging A with itself would turn ${a} eggs into ${2 * a}, so every repeated sync would inflate it`)}
      </ul>
    </div>
  );
}

type Guess = "3" | "4" | "more";

export default function CrdtPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const last = st.syncs[st.syncs.length - 1];
  const edits = st.nodes.reduce((k, r) => k + r.edits, 0);
  const editors = st.nodes.filter((r) => r.edits > 0).length;
  const repeats = st.syncs.filter((x) => !x.changed).length;
  const conv = converged(st);
  const naiveOff = Math.max(...st.nodes.map((r) => Math.abs(r.naive.eggs - eggs(r))));
  const back = new Set(st.nodes.flatMap(resurrected)).size;
  const t = Math.max(...st.nodes.map(tags)), d = Math.max(...st.nodes.map(tombstones)), v = Math.max(...st.nodes.map((r) => items(r).length));

  return (
    <PgFrame title="Three replicas of one shopping list" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}
      toolbar={<PgButton onClick={() => dispatch({ type: "syncAll" })}>Sync everyone</PgButton>}>
      <PgPredict<Guess>
        question="The list starts with 1 egg. Offline, Phone A taps +1 twice and Phone B taps +1 once. Then they sync both ways, twice. How many eggs?"
        options={[
          { value: "3", label: "3: the larger count wins" },
          { value: "4", label: "4: every tap counts once" },
          { value: "more", label: "More: the second sync adds them again" },
        ]}
        value={guess} onChange={setGuess} revealed={st.done.includes("concurrent-inc")} answer="4"
        explain={<>Each replica counts its own taps in its own entry: P is [3,1,0] after the merge, one starting egg and two taps from A, one tap from B. Merge takes the maximum of each entry, so a tap is never lost and a repeated sync never counts it twice. A plain number merged by max would say 3.</>}
      />
      <p className="cr-small muted">Every replica is offline until you press a Sync button, which sends that replica's whole state to another, which merges it. Edit on two replicas, then sync in any order, as often as you like.</p>

      <div className={"cr-nodes" + (reduced ? "" : " anim")}>
        {IDS.map((i) => <ReplicaCard key={i} st={st} i={i} dispatch={dispatch} />)}
      </div>

      <div className={"cr-banner" + (conv ? " ok" : "")} aria-live="polite">
        {conv ? "All three replicas hold identical state." : "The replicas differ. Sync them in any order and they will converge."}
      </div>

      {last && (
        <div className={"pg-entry" + (last.changed ? " ok" : "")} aria-live="polite">
          <div className="pg-path" aria-hidden="true"><span>{NODES[last.from]}</span><span>{NODES[last.to]}</span><span>{last.changed ? "merged" : "no change"}</span></div>
          <p>{last.text}</p>
        </div>
      )}

      <Laws st={st} />

      <div className="pg-req">
        <span className="label">Find it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="cr-ch">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.syncs.length >= 2 && edits >= 2 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your edits did</span>
          <p>
            You made {n(edits, "edit")} on {n(editors, "replica")} and ran {n(st.syncs.length, "sync")}, {repeats} of which changed nothing. The replicas {conv ? "now agree exactly" : "do not agree yet"}.
            {" "}The naive merge {naiveOff ? `is off by ${n(naiveOff, "egg")}` : "matches on eggs so far"}{back ? ` and brought back ${n(back, "removed item")}` : ""}. LWW dropped {n(st.lost.length, "slot pick")}{st.lost.length ? ` (${st.lost.map((l) => `${l.value} from ${NODES[l.by]}`).join(", ")})` : ""}.
            {" "}To show {n(v, "item")}, a replica keeps {n(t, "tag")} and {n(d, "tombstone")}.
          </p>
          <p className="pg-takeaway">
            A CRDT merge only ever moves state up: per-replica maxima, unions of tags. That makes it commutative, associative and idempotent, so any order and any number of syncs end in the same state. Converging is not the same as keeping intent. The counter keeps every tap, the OR-Set lets an add win, and the LWW register converges by discarding a choice. Pick the type for what your users expect.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Jake Lazaroff's An Interactive Intro to CRDTs", href: "https://jakelazaroff.com/words/an-interactive-intro-to-crdts/" },
        { title: "Shapiro et al., A comprehensive study of CRDTs (2011)", href: "https://inria.hal.science/inria-00555588" },
        { title: "crdt.tech", href: "https://crdt.tech/" },
      ]} />

      <style>{`
        .cr-small { font-size: .85rem; margin: 0; }
        .cr-nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
        .cr-node { display: grid; gap: 8px; align-content: start; }
        .cr-field { display: grid; gap: 4px; border-top: 1px solid var(--line); padding-top: 6px; }
        .cr-meta { font-size: .68rem; color: var(--ink-2); word-break: break-word; }
        .cr-dead { text-decoration: line-through; color: var(--pain); }
        .cr-count { display: flex; align-items: center; gap: 10px; }
        .cr-count b { font-family: var(--f-code); font-size: 1.3rem; min-width: 2ch; text-align: center; }
        .cr-neg { color: var(--pain); }
        .cr-list { list-style: none; padding: 0 !important; margin: 0; display: grid; gap: 2px; }
        .cr-list li { display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--line); background: var(--surface); padding: 2px 6px; font-size: .9rem; }
        .cr-x { border: 0; background: none; color: var(--ink-2); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 4px; }
        .cr-x:hover, .cr-x:focus-visible { color: var(--pain); }
        .cr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
        .cr-chip { font-family: var(--f-code); font-size: .7rem; border: 1px dashed var(--line); background: none; color: var(--ink); padding: 2px 6px; cursor: pointer; }
        .cr-chip:hover, .cr-chip:focus-visible { border-color: var(--accent); color: var(--accent); }
        .cr-naive { font-size: .78rem; margin: 0; color: var(--ink-2); border-left: 2px solid var(--line); padding-left: 6px; }
        .cr-naive.off { color: var(--pain); border-color: var(--pain); }
        .cr-banner { border: 1px solid var(--line); padding: 6px 10px; font-size: .9rem; }
        .cr-banner.ok { border-color: var(--good); color: var(--good); background: var(--good-bg); }
        .cr-nodes.anim .cr-node { transition: border-color .2s var(--ease); }
        .cr-laws, .cr-ch { list-style: none; padding-left: 0 !important; margin: 0; }
        .cr-laws li { font-size: .88rem; }
        .cr-laws li.ok span:first-child { color: var(--good); }
        .cr-laws li.bad { color: var(--pain); }
        .cr-ch li.got { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .cr-nodes.anim .cr-node { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
