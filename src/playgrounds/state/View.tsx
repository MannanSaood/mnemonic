"use client";
import { useState } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BUGS, EVENTS, FLAG_NAMES, STRESS_EVENTS, TOTAL, comboKey, flagProblem, init, lifeOf, machineProblem, stateName, step,
  type Entry, type Ev, type Flags, type Ledger, type Life, type State,
} from "./model";

const LABEL: Record<Ev, string> = { pay: `Pay $${TOTAL}`, ship: "Ship", deliver: "Deliver", cancel: "Cancel" };
const WHO: Record<Ev, string> = { pay: "payment webhook", ship: "warehouse scanner", deliver: "courier webhook", cancel: "customer or support" };

/* ---------------- flag side: every combination four booleans can make ---------------- */

const BITS = ["00", "01", "10", "11"];
function comboFlags(row: string, col: string): Flags {
  return { paid: row[0] === "1", shipped: row[1] === "1", delivered: col[0] === "1", cancelled: col[1] === "1" };
}

function ComboGrid({ st }: { st: State }) {
  const now = comboKey(st.flag.flags);
  return (
    <div className="state-grid" role="img" aria-label={`Flag combinations. Legal: 6 of 16. Current: ${lifeOf(st.flag.flags) ?? "impossible"}.`}>
      {BITS.map((row) => BITS.map((col) => {
        const f = comboFlags(row, col);
        const key = comboKey(f);
        const life = lifeOf(f);
        const seen = st.flag.visited.includes(key);
        const cls = ["state-cell", life ? "legal" : "illegal", seen ? "seen" : "", key === now ? "now" : ""].filter(Boolean).join(" ");
        return (
          <div key={key} className={cls}>
            <span className="state-bits">{FLAG_NAMES.map((n) => <i key={n} className={f[n] ? "on" : ""}>{n[0].toUpperCase()}</i>)}</span>
            <span className="state-name">{life ?? "impossible"}</span>
          </div>
        );
      }))}
    </div>
  );
}

/* ---------------- state side: the machine as a diagram ---------------- */

const BOX: Record<Life, { x: number; y: number; w: number }> = {
  pending: { x: 4, y: 20, w: 76 },
  paid: { x: 98, y: 20, w: 64 },
  shipped: { x: 180, y: 20, w: 74 },
  delivered: { x: 272, y: 20, w: 84 },
  cancelled: { x: 40, y: 104, w: 92 },
};
const H = 30;
const EDGES: { from: Life; to: Life; ev: Ev; d: string; lx: number; ly: number }[] = [
  { from: "pending", to: "paid", ev: "pay", d: "M80 35 H96", lx: 88, ly: 14 },
  { from: "paid", to: "shipped", ev: "ship", d: "M162 35 H178", lx: 170, ly: 14 },
  { from: "shipped", to: "delivered", ev: "deliver", d: "M254 35 H270", lx: 262, ly: 14 },
  { from: "pending", to: "cancelled", ev: "cancel", d: "M42 50 L66 102", lx: 30, ly: 82 },
  { from: "paid", to: "cancelled", ev: "cancel", d: "M130 50 L108 102", lx: 150, ly: 82 },
];

function Machine({ st, last }: { st: State; last: Entry | undefined }) {
  const life = st.machine.life;
  // The edge the last event took, if the state accepted it: path is [Method(), From.Method, ...].
  const took = last && !last.machine.path.includes("default: reject") ? last.machine.path[1].split(".")[0].toLowerCase() : null;
  return (
    <svg className="state-svg" viewBox="0 0 360 140" role="img" aria-label={`State machine. Current state: ${stateName(life)}.`}>
      <defs>
        <marker id="state-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" style={{ fill: "var(--ink-2)" }} />
        </marker>
      </defs>
      {EDGES.map((e) => {
        const hot = took === e.from && last?.ev === e.ev;
        return (
          <g key={e.from + e.to}>
            <path d={e.d} markerEnd="url(#state-arrow)" style={{ stroke: hot ? "var(--accent)" : "var(--ink-2)", strokeWidth: hot ? 2.5 : 1, fill: "none" }} />
            <text x={e.lx} y={e.ly} textAnchor="middle" className="state-svg-label">{e.ev}</text>
          </g>
        );
      })}
      {(Object.keys(BOX) as Life[]).map((l) => {
        const b = BOX[l];
        const on = l === life;
        return (
          <g key={l}>
            <rect x={b.x} y={b.y} width={b.w} height={H}
              style={{ fill: on ? "var(--accent)" : "var(--surface)", stroke: on ? "var(--accent)" : "var(--line)", transition: "fill .2s" }} />
            <text x={b.x + b.w / 2} y={b.y + 19} textAnchor="middle" className="state-svg-name" style={{ fill: on ? "var(--accent-ink)" : "var(--ink)" }}>{stateName(l)}</text>
          </g>
        );
      })}
      <text x={170} y={124} className="state-svg-label" textAnchor="start">anything not drawn: rejected</text>
    </svg>
  );
}

/* ---------------- shared bits ---------------- */

function Books({ l, problem }: { l: Ledger; problem: string | null }) {
  return (
    <dl className="pg-stats">
      <div><dt>Charged</dt><dd>${l.charged}</dd></div>
      <div className={l.refunded > l.charged ? "bad" : ""}><dt>Refunded</dt><dd>${l.refunded}</dd></div>
      <div className={l.parcels > 1 ? "bad" : ""}><dt>Parcels</dt><dd>{l.parcels}</dd></div>
      <div className={problem ? "bad" : ""}><dt>Books</dt><dd>{problem ? "Wrong" : "Balance"}</dd></div>
    </dl>
  );
}

function Last({ e, side, reduced }: { e: Entry | undefined; side: "flag" | "machine"; reduced: boolean }) {
  if (!e) return <p className="pg-empty">No events yet.</p>;
  const o = e[side];
  return (
    <div className={"pg-entry" + (o.ok ? " ok" : " fail") + (reduced ? "" : " fresh")} key={e.id} aria-live="polite">
      <div className="pg-path" aria-hidden="true">
        {o.path.map((p, j) => <span key={j} style={{ animationDelay: `${j * 110}ms` }}>{p}</span>)}
      </div>
      <p>{o.text}</p>
    </div>
  );
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

type Guess = "both-reject" | "flags-ship" | "both-ship";

export default function StatePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const last = st.log[0];
  const fp = flagProblem(st.flag), mp = machineProblem(st.machine);
  const revealed = st.found.includes("ship-cancelled") || st.stress !== null;

  return (
    <PgFrame title="One order, two designs, the same events" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="A customer cancels a paid order and gets a refund. A minute later the warehouse scanner sends Ship for the same order. What happens?"
        options={[
          { value: "both-reject", label: "Both designs refuse to ship" },
          { value: "flags-ship", label: "The flag order ships it; the state order refuses" },
          { value: "both-ship", label: "Both ship it" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="flags-ship"
        explain={<>Ship() only asks <code>if !paid</code>, and a refunded order is still paid = true. The author of Ship never thought about cancelled. The state order is in Cancelled, which has no Ship, so the event is refused without anyone writing that check.</>}
      />
      {!revealed && <p className="pg-rule">Now test it: press <b>Pay</b>, <b>Cancel</b>, <b>Ship</b>. Every event goes to both orders.</p>}

      <div className="pg-req">
        <span className="label">Send an event to order #1042 (${TOTAL})</span>
        <div className="pg-actions">
          {EVENTS.map((ev) => (
            <PgButton key={ev} onClick={() => dispatch({ type: "fire", ev })} title={`Sent by the ${WHO[ev]}`}>{LABEL[ev]}</PgButton>
          ))}
          <PgButton onClick={() => dispatch({ type: "resend" })} disabled={!st.last} title="Webhooks are delivered at least once: the same event can arrive again">
            Resend {st.last ? LABEL[st.last].split(" ")[0] : "last"} (webhook retry)
          </PgButton>
          <PgButton onClick={() => dispatch({ type: "newOrder" })}>New order</PgButton>
        </div>
        <p className="muted state-small">Events come from different systems that do not coordinate, and webhooks can arrive twice. Nothing stops them arriving in a bad order.</p>
      </div>

      <div className="pg-sides">
        <section className="pg-side" aria-label="Flag design">
          <header>
            <h4>Flag design</h4>
            <span className={"pg-status" + (fp ? "" : " done")}>{fp ? "Corrupted" : "Consistent"}</span>
          </header>
          <p className="muted state-small">Four booleans. Each method checks the flags its author thought of. 16 combinations, 6 of them real.</p>
          <ComboGrid st={st} />
          <Books l={st.flag.ledger} problem={fp} />
          {fp && <p className="state-problem">Problem: {fp}.</p>}
          <span className="label">Last event</span>
          <Last e={last} side="flag" reduced={reduced} />
        </section>
        <section className="pg-side" aria-label="State design">
          <header>
            <h4>State design</h4>
            <span className={"pg-status" + (mp ? "" : " done")}>{mp ? "Corrupted" : "Consistent"}</span>
          </header>
          <p className="muted state-small">One field holds the current state object. It accepts only the events drawn from it.</p>
          <Machine st={st} last={last} />
          <Books l={st.machine.ledger} problem={mp} />
          <span className="label">Last event</span>
          <Last e={last} side="machine" reduced={reduced} />
        </section>
      </div>

      <div className="pg-req">
        <span className="label">Break it: {st.found.length} of {BUGS.length} found</span>
        <ul className="state-bugs">
          {BUGS.map((b) => {
            const got = st.found.includes(b.id);
            return (
              <li key={b.id} className={got ? "got" : ""}>
                <span aria-hidden="true">{got ? "■" : "□"}</span> {b.title}
                <span className="muted"> · {got ? "the flag order did it; the state order refused" : `hint: ${b.hint}`}</span>
              </li>
            );
          })}
        </ul>
        <p className="muted state-small">Use New order between attempts. Found bugs stay ticked.</p>
      </div>

      <div className="pg-req">
        <span className="label">Stress test</span>
        <p>Run 200 orders through both designs. Each gets {STRESS_EVENTS} events: mostly the normal path, with the occasional cancel, stray event or retried webhook.</p>
        <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "stress" })}>{st.stress ? "Run another 200" : "Run 200 orders"}</PgButton></div>
        {st.stress && (
          <dl className="pg-stats" aria-live="polite">
            <div><dt>Events sent</dt><dd>{st.stress.events}</dd></div>
            <div className={st.stress.flagBad ? "bad" : ""}><dt>Flag orders broken</dt><dd>{st.stress.flagBad} / {st.stress.orders}</dd></div>
            <div><dt>State orders broken</dt><dd>{st.stress.machineBad} / {st.stress.orders}</dd></div>
            <div><dt>Events refused</dt><dd>{st.stress.machineRejected}</dd></div>
          </dl>
        )}
      </div>

      {st.sent > 0 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your events did</span>
          <p>
            You sent {n(st.sent, "event")} to this order. The flag order accepted {n(st.flag.badAccepts, "event")} that an order in its state should refuse
            {fp ? <>, and now its books are wrong: {fp}.</> : "."} The state order refused {n(st.machine.rejected, "event")} and its books {mp ? "are wrong" : "balance"}.
          </p>
          <p className="pg-takeaway">
            {st.flag.badAccepts > 0
              ? "Each flag method guards only against the combinations its author pictured, and every new flag doubles the combinations. The state order lists what each state accepts and refuses everything else by default, so a late or repeated event has nowhere to go."
              : "Nothing broke yet: in the normal order both designs agree. Real events arrive late and twice. Try a challenge below."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "refactoring.guru on State", href: "https://refactoring.guru/design-patterns/state" },
        { title: "Kent C. Dodds, Make Impossible States Impossible", href: "https://kentcdodds.com/blog/make-impossible-states-impossible" },
        { title: "the Stately (XState) visualizer", href: "https://stately.ai/viz" },
      ]} />

      <style>{`
        .state-small { font-size: .9rem; margin: 0; }
        .state-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px; background: var(--line); border: 1px solid var(--line); }
        .state-cell { background: var(--surface); padding: 4px; display: grid; gap: 2px; justify-items: center; min-height: 40px; transition: background .2s; }
        .state-cell.illegal { background: var(--bg); }
        .state-cell.illegal .state-name { color: var(--ink-2); opacity: .6; }
        .state-cell.legal .state-name { color: var(--good); }
        .state-cell.seen.illegal { background: var(--pain-bg); }
        .state-cell.seen.illegal .state-name { color: var(--pain); opacity: 1; }
        .state-cell.now { outline: 2px solid var(--accent); outline-offset: -2px; }
        .state-bits { display: flex; gap: 2px; font-family: var(--f-code); font-size: .6rem; }
        .state-bits i { font-style: normal; color: var(--ink-2); opacity: .35; }
        .state-bits i.on { opacity: 1; color: var(--ink); font-weight: 700; }
        .state-name { font-family: var(--f-code); font-size: .56rem; letter-spacing: .04em; text-transform: uppercase; }
        .state-svg { width: 100%; height: auto; background: var(--surface); border: 1px solid var(--line); }
        .state-svg-name { font-family: var(--f-code); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
        .state-svg-label { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
        .state-problem { margin: 0; color: var(--pain); font-size: .95rem; }
        .state-bugs { list-style: none; padding-left: 0 !important; }
        .state-bugs li.got { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .state-cell, .state-svg rect { transition: none !important; } }
      `}</style>
    </PgFrame>
  );
}
