"use client";
import { useState, type KeyboardEvent } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  NODES, START_MS, STEP_MS, SKEWS, evName, hb, init, inversions, lamportOrder, misleading, pending, step, ties, wall, wallOrder,
  type Action, type Challenge, type Ev, type NodeId, type Skew, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const IDS: NodeId[] = [0, 1, 2];
const LANE = [40, 112, 184];
const X0 = 40;
const PX = 2.1; // px per ms of real time

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "wall-lies", title: "Make the wall-clock order show a reply before the message it answers", note: "B's clock is slow, so its later events carry earlier timestamps" },
  { id: "jump", title: "Make a server's Lamport time jump by more than one", note: "a receive moves the clock past the message's time, then ticks" },
  { id: "tie", title: "Make two events on different servers share a Lamport time", note: "the server id breaks the tie, so the order is still total" },
  { id: "not-cause", title: "Select two events where the smaller Lamport time did not cause the other", note: "L(a) < L(b) is necessary for a → b, not sufficient" },
];

const SKEW_OPTS = SKEWS.map((s) => ({ value: String(s), label: s === 0 ? "in sync" : `${-s} ms slow` }));

function Diagram({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const sel = st.selected[st.selected.length - 1];
  const focus = sel === undefined ? null : st.events[sel];
  const x = (t: number) => X0 + (t - START_MS) * PX;
  const nowX = x(st.now + STEP_MS);
  const width = Math.max(560, nowX + 40);
  const key = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };
  return (
    <div className="lc-scroll">
      <svg className="lc-svg" viewBox={`0 0 ${width} 222`} width={width} height={222} role="group"
        aria-label="Space-time diagram. Real time runs left to right. Each lane is a chat server; arrows are messages. Press an event to select it, or a dashed arrow to deliver it.">
        <defs>
          <marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="lc-head" /></marker>
        </defs>
        {IDS.map((i) => (
          <g key={i}>
            <line x1={X0} x2={width - 6} y1={LANE[i]} y2={LANE[i]} className="lc-lane" />
            <text x={6} y={LANE[i] + 4} className="lc-name">{NODES[i]}</text>
            <text x={6} y={LANE[i] + 16} className="lc-skew">{st.skew[i] === 0 ? "±0" : st.skew[i] > 0 ? `+${st.skew[i]}` : st.skew[i]}</text>
          </g>
        ))}
        <line x1={nowX} x2={nowX} y1={20} y2={204} className="lc-now" />
        <text x={nowX} y={216} className="lc-tick">now {st.now + STEP_MS} ms</text>
        {st.msgs.map((m) => {
          const s = st.events[m.send];
          if (m.recv !== undefined) {
            const r = st.events[m.recv];
            return <line key={m.id} x1={x(s.t)} y1={LANE[s.node]} x2={x(r.t)} y2={LANE[r.node]} className="lc-msg" markerEnd="url(#lc-arrow)" />;
          }
          return (
            <g key={m.id} className="lc-fly" role="button" tabIndex={0} aria-label={`Deliver message from ${NODES[m.from]} to ${NODES[m.to]}, carrying L ${m.L}`}
              onClick={() => dispatch({ type: "deliver", msg: m.id })} onKeyDown={key(() => dispatch({ type: "deliver", msg: m.id }))}>
              <line x1={x(s.t)} y1={LANE[s.node]} x2={nowX} y2={LANE[m.to]} className="lc-msg flying" markerEnd="url(#lc-arrow)" />
              <rect x={nowX - 34} y={LANE[m.to] + (m.to > m.from ? -22 : 6)} width={30} height={14} className="lc-chip" />
              <text x={nowX - 19} y={LANE[m.to] + (m.to > m.from ? -12 : 16)} className="lc-chipt">L{m.L}</text>
            </g>
          );
        })}
        {st.events.map((e) => {
          const r = focus && focus.id !== e.id ? (hb(e, focus) ? "past" : hb(focus, e) ? "future" : "conc") : "";
          const up = e.node === 0 ? -1 : 1;
          const isSel = st.selected.includes(e.id);
          return (
            <g key={e.id} className={`lc-ev ${e.kind} ${r} ${isSel ? "sel" : ""}`} role="button" tabIndex={0} aria-pressed={isSel}
              aria-label={`${evName(e)} ${e.kind}, Lamport ${e.L}, wall clock ${wall(st, e)} ms`}
              onClick={() => dispatch({ type: "select", event: e.id })} onKeyDown={key(() => dispatch({ type: "select", event: e.id }))}>
              <circle cx={x(e.t)} cy={LANE[e.node]} r={9} />
              <text x={x(e.t)} y={LANE[e.node] + 3.5} className="lc-in">{e.L}</text>
              <text x={x(e.t)} y={LANE[e.node] + up * 16 + (up > 0 ? 6 : 0)} className="lc-lbl">{evName(e)}</text>
              <text x={x(e.t)} y={LANE[e.node] + up * 26 + (up > 0 ? 6 : 0)} className="lc-w">{wall(st, e)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Order({ st, title, order, bad }: { st: State; title: string; order: Ev[]; bad: [Ev, Ev][] }) {
  const early = new Set(bad.map(([, effect]) => effect.id));
  return (
    <div className={"lc-order" + (bad.length ? " bad" : "")}>
      <span className="label">{title} · {bad.length ? `${n(bad.length, "effect")} before ${bad.length === 1 ? "its" : "their"} cause` : "every cause first"}</span>
      <ol aria-label={title}>
        {order.map((e) => (
          <li key={e.id} className={(early.has(e.id) ? "early " : "") + (st.selected.includes(e.id) ? "sel" : "")}
            title={early.has(e.id) ? `${evName(e)} is shown before an event that happened before it` : undefined}>
            {evName(e)}
          </li>
        ))}
        {order.length === 0 && <li className="none">no events yet</li>}
      </ol>
    </div>
  );
}

function Pair({ st }: { st: State }) {
  if (st.selected.length < 2) {
    return <p className="lc-small muted">Press two events in the diagram to compare them.{st.selected.length === 1 && " The tint shows the selected event's causal past (light) and future (dark). Plain dots are concurrent with it."}</p>;
  }
  const [a, b] = st.selected.map((i) => st.events[i]);
  const na = evName(a), nb = evName(b);
  const truth = hb(a, b) ? `${na} happened before ${nb}: a chain of events and messages leads from one to the other.`
    : hb(b, a) ? `${nb} happened before ${na}: a chain of events and messages leads from one to the other.`
      : `${na} and ${nb} are concurrent: no chain of messages links them, so neither could have influenced the other.`;
  const lamport = a.L === b.L ? `Lamport times are equal (${a.L}); the server id puts ${a.node < b.node ? na : nb} first.`
    : `Lamport order puts ${a.L < b.L ? na : nb} first (${Math.min(a.L, b.L)} < ${Math.max(a.L, b.L)}).`;
  const wa = wall(st, a), wb = wall(st, b);
  const wallSays = wa === wb ? "Wall clocks show the same millisecond." : `Wall clocks put ${wa < wb ? na : nb} first (${Math.min(wa, wb)} < ${Math.max(wa, wb)} ms).`;
  const wallWrong = (hb(a, b) && wb < wa) || (hb(b, a) && wa < wb);
  const conc = !hb(a, b) && !hb(b, a);
  return (
    <div className={"pg-entry" + (wallWrong ? " fail" : " ok")} aria-live="polite">
      <div className="pg-path" aria-hidden="true"><span>{na} · L{a.L}</span><span>{nb} · L{b.L}</span></div>
      <p><b>{truth}</b></p>
      <p>{lamport} {conc ? "That order is consistent with causality, but here it is an arbitrary choice, not evidence of cause." : "That agrees, as it must."}</p>
      <p>{wallSays} {wallWrong ? "That is backwards: the effect carries the earlier timestamp because its server's clock is slow." : ""}</p>
    </div>
  );
}

function Server({ st, i, dispatch }: { st: State; i: NodeId; dispatch: (a: Action) => void }) {
  const inbox = pending(st, i);
  return (
    <section className="pg-side lc-node" aria-label={`Server ${NODES[i]}`}>
      <header><h4>Server {NODES[i]}</h4><code className="lc-small">L = {st.clocks[i]}</code></header>
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "post", node: i })} title="A user posts a chat message on this server">Post</PgButton>
        {IDS.filter((j) => j !== i).map((j) => <PgButton key={j} onClick={() => dispatch({ type: "send", from: i, to: j })}>Send to {NODES[j]}</PgButton>)}
      </div>
      {inbox.length > 0 && (
        <div className="pg-actions">
          {inbox.map((m) => <PgButton key={m.id} primary onClick={() => dispatch({ type: "deliver", msg: m.id })}>Deliver from {NODES[m.from]} (L{m.L})</PgButton>)}
        </div>
      )}
    </section>
  );
}

type Guess = "question" | "reply" | "same";

export default function LamportClockPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const wo = wallOrder(st), lo = lamportOrder(st);
  const wBad = inversions(wo), lBad = inversions(lo);
  const tieCount = ties(st).length;
  const misCount = misleading(st).length;
  const revealed = st.done.includes("wall-lies");

  return (
    <PgFrame title="Three chat servers, two kinds of time" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}
      toolbar={<PgChoice label="Server B's wall clock" value={String(st.skew[1])} options={SKEW_OPTS} onChange={(v) => dispatch({ type: "skewB", ms: Number(v) as Skew })} />}>
      <PgPredict<Guess>
        question="A user on server A posts a question. A sends it to B. A user on B reads it and posts a reply 20 ms later. B's clock is 80 ms slow. Sorted by server timestamp, which shows first?"
        options={[
          { value: "question", label: "The question" },
          { value: "reply", label: "The reply" },
          { value: "same", label: "They tie" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="reply"
        explain={<>The reply really happened 60 ms after the question, but B stamps it with a clock 80 ms behind, so its timestamp is 20 ms earlier. No amount of care in the sort fixes that. The Lamport times are 1 for the question and 4 for the reply: the receive pushed B's clock past the message, so the reply cannot sort first.</>}
      />
      <p className="lc-small muted">Try it: on A press Post, then Send to B; deliver the dashed arrow; on B press Post. The number in each dot is its Lamport time, the number beside it is the server's wall-clock stamp in ms. The x axis is real time, which no server can see.</p>

      <Diagram st={st} dispatch={dispatch} />
      <div className={"lc-nodes" + (reduced ? "" : " anim")}>
        {IDS.map((i) => <Server key={i} st={st} i={i} dispatch={dispatch} />)}
      </div>

      <div className="lc-orders">
        <Order st={st} title="Sorted by wall clock" order={wo} bad={wBad} />
        <Order st={st} title="Sorted by (Lamport, server)" order={lo} bad={lBad} />
      </div>
      <Pair st={st} />

      <div className="pg-req">
        <span className="label">Find it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="lc-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.events.length >= 4 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your run showed</span>
          <p>
            You made {n(st.events.length, "event")} and {n(st.msgs.length, "message")}. With B's clock {st.skew[1] === 0 ? "in sync" : `${-st.skew[1]} ms slow`}, the wall-clock order showed {n(wBad.length, "effect")} before {wBad.length === 1 ? "its" : "their"} cause; the Lamport order showed {lBad.length}.
            {" "}{tieCount > 0 ? `${n(tieCount, "pair")} tied on Lamport time and the server id decided. ` : ""}
            {misCount > 0 ? `${n(misCount, "pair")} had a smaller Lamport time without being a cause.` : ""}
          </p>
          <p className="pg-takeaway">
            A Lamport clock counts events instead of measuring time, and every message drags the receiver's counter past the sender's. So a cause always gets the smaller number, on any server, with any skew. Ties go to the server id, which makes the order total. The reverse never holds: a smaller number only means "could have come first".
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Lamport, Time, Clocks, and the Ordering of Events (1978)", href: "https://lamport.azurewebsites.net/pubs/time-clocks.pdf" },
        { title: "TSViz, which draws the logical order and the physical timestamps of one log side by side", href: "https://www.cs.ubc.ca/~bestchai/papers/tsviz-icse17tool.pdf" },
        { title: "Michael Whittaker's Lamport's Logical Clocks", href: "https://mwhittaker.github.io/blog/lamports_logical_clocks" },
      ]} />

      <style>{`
        .lc-small { font-size: .85rem; margin: 0; }
        .lc-scroll { overflow-x: auto; border: 1px solid var(--line); background: var(--surface); }
        .lc-svg { display: block; }
        .lc-lane { stroke: var(--ink-2); stroke-width: 1; }
        .lc-now { stroke: var(--line); stroke-dasharray: 2 3; }
        .lc-tick { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); text-anchor: end; }
        .lc-name { font-family: var(--f-code); font-size: 12px; font-weight: 700; fill: var(--ink); }
        .lc-skew { font-family: var(--f-code); font-size: 8px; fill: var(--ink-2); }
        .lc-msg { stroke: var(--accent); stroke-width: 1.3; }
        .lc-msg.flying { stroke-dasharray: 4 3; }
        .lc-head { fill: var(--accent); }
        .lc-fly { cursor: pointer; outline: none; }
        .lc-chip { fill: var(--accent); }
        .lc-chipt { font-family: var(--f-code); font-size: 9px; fill: var(--accent-ink); text-anchor: middle; pointer-events: none; }
        .lc-fly:focus-visible .lc-chip, .lc-fly:hover .lc-chip { stroke: var(--ink); stroke-width: 2; }
        .lc-ev { cursor: pointer; outline: none; }
        .lc-ev circle { fill: var(--bg); stroke: var(--ink); stroke-width: 1.3; ${reduced ? "" : "transition: fill .2s var(--ease), stroke .2s var(--ease);"} }
        .lc-ev.post circle { stroke: var(--accent); stroke-width: 2; }
        .lc-ev.past circle { fill: var(--good-bg); stroke: var(--good); }
        .lc-ev.future circle { fill: var(--ink); }
        .lc-ev.future .lc-in { fill: var(--bg); }
        .lc-ev.sel circle { fill: var(--accent); stroke: var(--accent); }
        .lc-ev.sel .lc-in { fill: var(--accent-ink); }
        .lc-ev:focus-visible circle { stroke-width: 3; stroke: var(--accent); }
        .lc-in { font-family: var(--f-code); font-size: 9px; font-weight: 700; text-anchor: middle; fill: var(--ink); pointer-events: none; }
        .lc-lbl { font-family: var(--f-code); font-size: 8px; text-anchor: middle; fill: var(--ink-2); text-transform: uppercase; }
        .lc-w { font-family: var(--f-code); font-size: 8.5px; text-anchor: middle; fill: var(--ink); }
        .lc-nodes { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
        .lc-orders { display: grid; gap: 8px; }
        .lc-order { border: 1px solid var(--line); padding: 6px 8px; background: var(--surface); }
        .lc-order.bad { border-color: var(--pain); }
        .lc-order ol { list-style: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 0 !important; margin: 4px 0 0; }
        .lc-order li { font-family: var(--f-code); font-size: .75rem; border: 1px solid var(--line); padding: 1px 6px; text-transform: uppercase; }
        .lc-order li.early { border-color: var(--pain); background: var(--pain-bg); color: var(--pain); }
        .lc-order li.sel { outline: 2px solid var(--accent); }
        .lc-order li.none { border: none; color: var(--ink-2); text-transform: none; }
        .lc-list { list-style: none; padding-left: 0 !important; }
        .lc-list li.got { color: var(--good); }
      `}</style>
    </PgFrame>
  );
}
