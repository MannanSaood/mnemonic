"use client";
import { useState, type KeyboardEvent } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  NODES, compare, cone, evName, fmt, init, pending, step,
  type Action, type Challenge, type Ev, type NodeId, type Relation, type State, type Version,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const IDS: NodeId[] = [0, 1, 2];

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "lamport-lies", title: "Select two concurrent events with different Lamport times", note: "a smaller Lamport time does not mean it happened first" },
  { id: "causal", title: "Select two events on different nodes where one happened before the other", note: "only a chain of messages links them, and the vector carries that chain" },
  { id: "conflict", title: "Make a replica hold two versions of the cart", note: "the version vectors were concurrent, so neither could replace the other" },
  { id: "resolved", title: "Merge the siblings and ship the merge to another replica", note: "the merged vector dominates both, so the other replica simply replaces" },
];

/* ---------------- the space-time diagram ---------------- */

const LANE = [42, 112, 182];
const DX = 46, X0 = 48;

function SpaceTime({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const sel = st.selected[st.selected.length - 1];
  const rel: Relation[] | null = sel === undefined ? null : cone(st, sel);
  const x = (e: Ev) => X0 + e.id * DX + 20;
  const width = Math.max(560, X0 + (st.events.length + 2) * DX);
  const nowX = X0 + st.events.length * DX + 20;
  const key = (id: number) => (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dispatch({ type: "select", event: id }); } };
  return (
    <div className="vc-scroll">
      <svg className="vc-svg" viewBox={`0 0 ${width} 214`} width={width} height={214} role="group"
        aria-label="Space-time diagram. Time runs left to right. Each lane is a replica; arrows are messages.">
        {IDS.map((i) => (
          <g key={i}>
            <line x1={X0} x2={width - 8} y1={LANE[i]} y2={LANE[i]} className="vc-lane" />
            <text x={8} y={LANE[i] + 4} className="vc-name">{NODES[i]}</text>
          </g>
        ))}
        {st.msgs.map((m) => {
          const s = st.events[m.send];
          const r = m.recv === undefined ? null : st.events[m.recv];
          return r
            ? <line key={m.id} x1={x(s)} y1={LANE[s.node]} x2={x(r)} y2={LANE[r.node]} className="vc-msg" markerEnd="url(#vc-arrow)" />
            : <line key={m.id} x1={x(s)} y1={LANE[s.node]} x2={nowX} y2={LANE[m.to]} className="vc-msg flying" markerEnd="url(#vc-arrow)" />;
        })}
        <defs>
          <marker id="vc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="vc-head" />
          </marker>
        </defs>
        {st.events.map((e) => {
          const r = rel?.[e.id];
          const cls = ["vc-ev", e.kind, e.outcome === "conflict" ? "conflict" : "",
            st.selected.includes(e.id) ? "sel" : "", r === "before" ? "past" : r === "after" ? "future" : r === "concurrent" ? "conc" : ""].join(" ");
          const up = e.node === 0 ? -1 : 1;
          return (
            <g key={e.id} className={cls} role="button" tabIndex={0} aria-pressed={st.selected.includes(e.id)}
              aria-label={`${evName(st, e.id)} ${e.label}, vector ${fmt(e.vc)}, Lamport ${e.lamport}`}
              onClick={() => dispatch({ type: "select", event: e.id })} onKeyDown={key(e.id)}>
              <circle cx={x(e)} cy={LANE[e.node]} r={8} />
              <text x={x(e)} y={LANE[e.node] + 3} className="vc-in">{e.lamport}</text>
              <text x={x(e)} y={LANE[e.node] + up * 15 + (up > 0 ? 6 : 0)} className="vc-vec">{fmt(e.vc)}</text>
              <text x={x(e)} y={LANE[e.node] + up * 26 + (up > 0 ? 6 : 0)} className="vc-lbl">{evName(st, e.id)} {e.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------------- the pair comparison ---------------- */

function Pair({ st }: { st: State }) {
  if (st.selected.length < 2) {
    return <p className="vc-small muted">Press two events in the diagram to compare them. {st.selected.length === 1 && "The tint shows the selected event's causal past (light) and future (dark). Plain dots are concurrent with it."}</p>;
  }
  const [a, b] = st.selected.map((i) => st.events[i]);
  const rel = compare(a.vc, b.vc);
  const na = evName(st, a.id), nb = evName(st, b.id);
  const lamportSays = a.lamport === b.lamport ? `the same Lamport time (${a.lamport})` : a.lamport < b.lamport ? `${na} first (${a.lamport} < ${b.lamport})` : `${nb} first (${b.lamport} < ${a.lamport})`;
  const verdict = rel === "concurrent" ? `${na} and ${nb} are concurrent: neither could have influenced the other.`
    : rel === "before" ? `${na} happened before ${nb}: every entry of ${fmt(a.vc)} is ≤ ${fmt(b.vc)}.`
      : rel === "after" ? `${nb} happened before ${na}: every entry of ${fmt(b.vc)} is ≤ ${fmt(a.vc)}.` : "The same event.";
  return (
    <div className={"pg-entry" + (rel === "concurrent" ? " fail" : " ok")} aria-live="polite">
      <div className="pg-path" aria-hidden="true"><span>{na} {fmt(a.vc)}</span><span>{nb} {fmt(b.vc)}</span></div>
      <p><b>{verdict}</b></p>
      <p>Lamport clocks say {lamportSays}. {rel === "concurrent" ? "That order is real for sorting, but it says nothing about cause." : "That agrees, as it must: if one event happened before another, its Lamport time is smaller."}</p>
    </div>
  );
}

/* ---------------- one replica ---------------- */

const items = (v: Version) => (v.items.length ? v.items.join(", ") : "empty");

function ReplicaCard({ st, i, dispatch }: { st: State; i: NodeId; dispatch: (a: Action) => void }) {
  const r = st.nodes[i];
  const sib = r.versions.length > 1;
  const inbox = pending(st, i);
  return (
    <section className={"pg-side vc-node" + (sib ? " sib" : "")} aria-label={`Replica ${NODES[i]}`}>
      <header><h4>Replica {NODES[i]}</h4><code className="vc-small">clock {fmt(r.vc)} · L {r.lamport}</code></header>
      <div className="vc-cart" aria-live="polite">
        <span className="label">{sib ? `Cart: ${r.versions.length} siblings` : "Cart"}</span>
        {r.versions.map((v, k) => <div key={k} className="vc-ver"><span>{items(v)}</span><code>{fmt(v.vv)}</code></div>)}
      </div>
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "write", node: i })} disabled={sib} title={sib ? "Merge the siblings first" : "A customer adds an item on this replica"}>Add item</PgButton>
        {IDS.filter((j) => j !== i).map((j) => <PgButton key={j} onClick={() => dispatch({ type: "send", from: i, to: j })}>Send to {NODES[j]}</PgButton>)}
        {sib && <PgButton primary onClick={() => dispatch({ type: "merge", node: i })}>Merge siblings</PgButton>}
      </div>
      {inbox.length > 0 && (
        <div className="pg-actions">
          {inbox.map((m) => (
            <PgButton key={m.id} primary onClick={() => dispatch({ type: "deliver", msg: m.id })}>
              Deliver from {NODES[m.from]} ({m.payload.map(items).join(" | ")})
            </PgButton>
          ))}
        </div>
      )}
    </section>
  );
}

function LastReceive({ st }: { st: State }) {
  if (!st.last) return null;
  const e = st.events[st.last.event];
  const m = st.msgs[e.msg!];
  const who = NODES[e.node], from = NODES[m.from];
  const text = {
    replaced: `${from}'s version vector dominated ${who}'s, so ${who} replaced its cart.`,
    kept: `${who} already had everything ${from} sent (its vector dominates), so it kept its cart.`,
    same: `${who} already had exactly this version.`,
    conflict: `Neither version vector dominates the other. ${who} keeps both as siblings, and the next writer must merge them.`,
  }[st.last.outcome];
  return (
    <div className={"pg-entry" + (st.last.outcome === "conflict" ? " fail" : " ok")} aria-live="polite">
      <div className="pg-path" aria-hidden="true"><span>{from}</span><span>{who}</span><span>{st.last.outcome}</span></div>
      <p>{text}</p>
      {st.last.outcome === "conflict" && st.last.lwwDrops.length > 0 && (
        <p>Last-write-wins by Lamport time would have kept one cart and silently dropped <b>{st.last.lwwDrops.join(", ")}</b>.</p>
      )}
    </div>
  );
}

type Guess = "lamp" | "book" | "both";

export default function VectorClockPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const conflicts = st.events.filter((e) => e.outcome === "conflict").length;
  const drops = st.events.reduce((k, e) => k + (e.drops?.length ?? 0), 0);
  const revealed = conflicts > 0;

  return (
    <PgFrame title="Three cart replicas on a space-time diagram" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Replica A adds a book and sends its cart to B. Before that message arrives, B adds a lamp. Then the message arrives at B. What does B keep?"
        options={[
          { value: "lamp", label: "Only its own cart, with the lamp" },
          { value: "book", label: "Only A's cart, with the book" },
          { value: "both", label: "Both carts, flagged as a conflict" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="both"
        explain={<>A's version is [1,0,0] and B's is [0,1,0]. Neither is ≤ the other in every entry, so neither write saw the other: they are concurrent. Keeping one would silently lose an item, so B keeps both as siblings and the next writer merges them.</>}
      />

      <SpaceTime st={st} dispatch={dispatch} />
      <p className="vc-small muted">The number inside each dot is its Lamport time; the brackets are its vector clock [A,B,C]. Dashed arrows are messages still in flight.</p>
      <Pair st={st} />

      <div className={"vc-nodes" + (reduced ? "" : " anim")}>
        {IDS.map((i) => <ReplicaCard key={i} st={st} i={i} dispatch={dispatch} />)}
      </div>
      <LastReceive st={st} />

      <div className="pg-req">
        <span className="label">Find it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="vc-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.events.length >= 4 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your session showed</span>
          <p>
            You made {n(st.events.length, "event")} and sent {n(st.msgs.length, "message")}. Version vectors caught {n(conflicts, "conflict")}; last-write-wins by Lamport time would have dropped {n(drops, "item")} without a trace.
          </p>
          <p className="pg-takeaway">
            A Lamport time puts every event in one line, so it cannot say when two events were unrelated. A vector keeps one counter per node, so comparing two vectors says exactly whether one saw the other. Stores use that to keep concurrent versions side by side; they detect the conflict, and your code still has to merge it.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Lamport, Time, Clocks, and the Ordering of Events (1978)", href: "https://lamport.azurewebsites.net/pubs/time-clocks.pdf" },
        { title: "ShiViz, a space-time visualiser for vector-timestamped logs", href: "https://www.cs.ubc.ca/~bestchai/papers/tosem20-shiviz.pdf" },
        { title: "the Dynamo paper's shopping cart", href: "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf" },
      ]} />

      <style>{`
        .vc-small { font-size: .85rem; margin: 0; }
        .vc-scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--surface); }
        .vc-svg { display: block; }
        .vc-lane { stroke: var(--ink-2); stroke-width: 1; }
        .vc-name { font-family: var(--f-code); font-size: 12px; font-weight: 700; fill: var(--ink); }
        .vc-msg { stroke: var(--accent); stroke-width: 1.3; }
        .vc-msg.flying { stroke-dasharray: 4 3; opacity: .8; }
        .vc-head { fill: var(--accent); }
        .vc-ev { cursor: pointer; outline: none; }
        .vc-ev circle { fill: var(--bg); stroke: var(--ink); stroke-width: 1.3; ${reduced ? "" : "transition: fill .2s var(--ease), stroke .2s var(--ease);"} }
        .vc-ev.write circle, .vc-ev.merge circle { stroke: var(--accent); stroke-width: 2; }
        .vc-ev.conflict circle { stroke: var(--pain); stroke-width: 2.2; }
        .vc-ev.past circle { fill: var(--good-bg); stroke: var(--good); }
        .vc-ev.future circle { fill: var(--ink); }
        .vc-ev.future .vc-in { fill: var(--bg); }
        .vc-ev.sel circle { fill: var(--accent); stroke: var(--accent); }
        .vc-ev.sel .vc-in { fill: var(--accent-ink); }
        .vc-ev:focus-visible circle { stroke-width: 3; stroke: var(--accent); }
        .vc-in { font-family: var(--f-code); font-size: 8px; text-anchor: middle; fill: var(--ink); pointer-events: none; }
        .vc-vec { font-family: var(--f-code); font-size: 9px; text-anchor: middle; fill: var(--ink); }
        .vc-lbl { font-family: var(--f-code); font-size: 7.5px; text-anchor: middle; fill: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; }
        .vc-nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
        .vc-node.sib { border-color: var(--pain); }
        .vc-nodes.anim .vc-node { transition: border-color .2s var(--ease); }
        .vc-cart { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 3px; }
        .vc-ver { display: flex; justify-content: space-between; gap: 8px; font-size: .9rem; }
        .vc-node.sib .vc-ver { color: var(--pain); }
        .vc-ver code { font-size: .7rem; }
        .vc-list { list-style: none; padding-left: 0 !important; }
        .vc-list li.got { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .vc-nodes.anim .vc-node { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
