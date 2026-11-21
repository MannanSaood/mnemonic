"use client";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ALL, BEST_COST, CHALLENGES, DESKS, TICKETS, challengeDone, disputeResult, init, step, summary,
  type Result, type State,
} from "./model";

const money = (x: number) => `$${x % 1 ? x.toFixed(2) : x}`;
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Outcome({ r }: { r: Result }) {
  if (r.outcome === "handled") return <p>Handled by {DESKS[r.by!].name} for {money(r.cost)}.</p>;
  if (r.outcome === "swallowed") return <p className="cor-bad">Swallowed by {DESKS[r.hops[r.hops.length - 1].desk].name}: it could not handle it and did not pass it on. The customer waits forever.</p>;
  return <p className="cor-bad">Fell off the end of the chain. No desk took it, nobody was told, and the customer never hears back.</p>;
}

function Chain({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const last = st.results[st.results.length - 1];
  const missing = ALL.filter((id) => !st.chain.includes(id));
  const closed = st.chain[st.chain.length - 1] === "lead";
  return (
    <div className="pg-card">
      <span className="label">The chain · a ticket starts on the left and moves right until a desk takes it</span>
      <ol className="cor-chain">
        {st.chain.map((id, i) => {
          const d = DESKS[id];
          const hit = last?.by === id;
          return (
            <li key={id} className={(hit ? "hit " : "") + (st.swallows.includes(id) ? "buggy" : "")}>
              <b>{i + 1}. {d.name}</b>
              <span className="muted">{d.rule}</span>
              <span className="cor-cost">{money(d.cost)} a ticket</span>
              <div className="cor-tools">
                <button className="pg-btn" aria-label={`Move ${d.name} earlier`} disabled={i === 0} onClick={() => dispatch({ type: "move", id, by: -1 })}>←</button>
                <button className="pg-btn" aria-label={`Move ${d.name} later`} disabled={i === st.chain.length - 1} onClick={() => dispatch({ type: "move", id, by: 1 })}>→</button>
                <button className="pg-btn" aria-label={`Remove ${d.name}`} onClick={() => dispatch({ type: "remove", id })}>×</button>
              </div>
              <label className="cor-check">
                <input type="checkbox" checked={st.swallows.includes(id)} onChange={() => dispatch({ type: "toggleSwallow", id })} />
                Bug: forgets to pass on
              </label>
            </li>
          );
        })}
        <li className={"cor-end" + (closed ? " closed" : "")}>
          <b>End of chain</b>
          <span>{closed ? "The support lead takes everything, so nothing reaches here." : "A ticket that gets here is dropped without a trace."}</span>
        </li>
      </ol>
      {missing.length > 0 && (
        <div className="pg-actions">
          {missing.map((id) => <PgButton key={id} onClick={() => dispatch({ type: "add", id })}>+ {DESKS[id].name}</PgButton>)}
        </div>
      )}
    </div>
  );
}

function Result({ st }: { st: State }) {
  if (st.cursor < TICKETS.length) return null;
  const s = summary(st.results);
  const lostNames = st.results.filter((r) => r.outcome !== "handled").map((r) => `#${r.ticket.id}`);
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this chain did with eight tickets</span>
      <p>
        {n(s.handled, "ticket")} handled for {money(s.cost)}{s.overpaid > 0 ? `, ${money(s.overpaid)} more than the cheapest desk that could have taken each one` : ", the cheapest possible"}.{" "}
        {s.lost ? `${n(s.lost, "ticket")} lost (${lostNames.join(", ")}).` : "Nothing was lost."} The best chain costs {money(BEST_COST)} and loses nothing.
      </p>
      <p className="pg-takeaway">
        {s.lost
          ? "The customer who sent a lost ticket was never told no; the ticket just stopped. The sender does not know who handles a request, so nothing guarantees anyone does. Give every chain a deliberate end: a catch-all desk, or an explicit unhandled result someone sees."
          : s.overpaid > 0
            ? "Nothing was lost, but order is policy. The first desk that can handle a ticket takes it, so an expensive desk early in the chain takes work a cheaper desk could have done."
            : "Nothing lost, nothing overpaid. Cheap, narrow desks first, broad ones later, and a catch-all last: that ordering is the whole design of a chain."}
      </p>
    </div>
  );
}

export default function ChainPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const dispute = disputeResult(st);
  const s = summary(st.results);
  const answer = dispute ? (dispute.outcome === "handled" ? dispute.by! : "nobody") : "nobody";

  return (
    <PgFrame title="Support tickets down a chain of desks" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="Ticket #3 disputes a $2,400 charge. The chain is Help bot, Tier 1, Tier 2 billing (up to $1,000), Engineering on-call. Who handles it?"
        options={[{ value: "tier2", label: "Tier 2 billing" }, { value: "eng", label: "Engineering, the last desk" }, { value: "nobody", label: "Nobody" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!dispute}
        answer={answer}
        explain={dispute?.outcome === "handled"
          ? `Your chain had changed by then: ${DESKS[dispute.by!].name} took it. With the starting chain nobody does, because no desk accepts a dispute over $1,000 and the chain has no end that catches what is left.`
          : "Nobody. Each desk checks whether it can handle the ticket and passes it on if not. No desk accepts a dispute over $1,000, so the ticket walks off the end of the chain. Nothing fails and nothing is logged: the request is simply never handled."}
      />

      <Chain st={st} dispatch={dispatch} />

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "send" })}>
          {st.cursor >= TICKETS.length ? "Start again: send ticket #1" : `Send ticket #${TICKETS[st.cursor].id}`}
        </PgButton>
        <PgButton onClick={() => dispatch({ type: "sendAll" })}>Send all eight</PgButton>
      </div>

      <div className="pg-card">
        <span className="label">Tickets · {st.results.length} of {TICKETS.length} sent</span>
        <dl className="pg-stats">
          <div><dt>Handled</dt><dd>{s.handled}</dd></div>
          <div className={s.lost ? "bad" : ""}><dt>Lost</dt><dd>{s.lost}</dd></div>
          <div><dt>Cost</dt><dd>{money(s.cost)}</dd></div>
          <div className={s.overpaid ? "bad" : ""}><dt>Overpaid</dt><dd>{money(s.overpaid)}</dd></div>
        </dl>
        <div className="pg-log" aria-live="polite">
          {st.results.length === 0 && <p className="pg-empty">No tickets yet. Changing the chain starts the eight tickets over.</p>}
          {[...st.results].reverse().map((r, i) => (
            <div key={r.ticket.id} className={"pg-entry" + (r.outcome === "handled" ? " ok" : " fail") + (i === 0 && !reduced ? " fresh" : "")}>
              <div className="pg-path">
                <span>#{r.ticket.id}</span>
                {r.hops.map((h, j) => (
                  <span key={h.desk} style={{ animationDelay: `${(j + 1) * 120}ms` }}>{DESKS[h.desk].name} {h.took ? "✓" : "passes"}</span>
                ))}
                {r.outcome === "dropped" && <span style={{ animationDelay: `${(r.hops.length + 1) * 120}ms` }}>end ✗</span>}
              </div>
              <p><b>{r.ticket.text}.</b></p>
              <Outcome r={r} />
            </div>
          ))}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="cor-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Refactoring.Guru's Chain of Responsibility", href: "https://refactoring.guru/design-patterns/chain-of-responsibility" },
        { title: "Express's guide to writing middleware", href: "https://expressjs.com/en/guide/writing-middleware.html" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.cor-chain { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: stretch; }
.cor-chain li { flex: 1 1 140px; min-width: 0; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 3px; align-content: start; position: relative; transition: border-color .2s var(--ease), background .2s var(--ease); }
.cor-chain li b { font-size: .92rem; }
.cor-chain li .muted { font-size: .82rem; }
.cor-chain li.hit { border-color: var(--good); background: var(--good-bg); }
.cor-chain li.buggy { border-style: dashed; border-color: var(--pain); }
.cor-chain li.cor-end { border-color: var(--pain); background: var(--pain-bg); font-size: .85rem; }
.cor-chain li.cor-end.closed { border-color: var(--line); background: var(--bg); color: var(--ink-2); }
.cor-cost { font-family: var(--f-code); font-size: .66rem; color: var(--ink-2); }
.cor-tools { display: flex; gap: 4px; }
.cor-tools .pg-btn { padding: 1px 8px; font-size: .8rem; }
.cor-check { display: flex; gap: 5px; align-items: center; font-size: .78rem; color: var(--ink-2); }
.cor-bad { color: var(--pain); }
.cor-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.cor-ch li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .cor-chain li { transition: none; } }
`;
