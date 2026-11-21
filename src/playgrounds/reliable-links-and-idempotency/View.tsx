"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  AMOUNT, BATCH_ATTEMPTS, CHALLENGES, MAX_ATTEMPTS, POLICIES, POLICY_LABEL, POLICY_NAME,
  challengeDone, chargesFor, currentPayment, init, step, tally,
  type BatchStats, type Policy, type Row, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const LANE = { client: 46, net: 170, service: 294 };
const ROW_H = 42;
const SHOW = 7;

function Arrow({ r, i }: { r: Row; i: number }) {
  const y = 34 + i * ROW_H;
  const req = r.dir === "req";
  const from = req ? LANE.client : LANE.service;
  const to = req ? LANE.service : LANE.client;
  const mid = LANE.net;
  const bad = r.fate === "dropped" || r.fate === "unsent";
  const cls = "rl-msg" + (bad ? " bad" : r.fate === "flying" ? " flying" : "");
  const end = r.fate === "delivered" ? to : mid;
  return (
    <g className={cls}>
      <text x={(LANE.client + LANE.service) / 2} y={y - 6} textAnchor="middle" className="rl-label">{`#${r.attempt} ${r.label}`}</text>
      {r.fate === "unsent" ? (
        <text x={LANE.service - 4} y={y + 4} textAnchor="end" className="rl-x">✗ crashed before replying</text>
      ) : (
        <>
          <line x1={from} y1={y} x2={end} y2={y} markerEnd={r.fate === "delivered" ? "url(#rl-head)" : undefined} />
          {r.fate === "dropped" && <text x={mid} y={y + 5} textAnchor="middle" className="rl-x">✗</text>}
          {r.fate === "flying" && <circle cx={mid} cy={y} r={5} className="rl-packet" />}
        </>
      )}
      {r.note && <text x={(LANE.client + LANE.service) / 2} y={y + 15} textAnchor="middle" className="rl-note">{r.note}</text>}
    </g>
  );
}

function Sequence({ st }: { st: State }) {
  const rows = st.rows.slice(-SHOW);
  const h = 24 + Math.max(rows.length, 3) * ROW_H + 8;
  return (
    <svg className="rl-seq" viewBox={`0 0 340 ${h}`} role="img" aria-label={`Message sequence: ${rows.map((r) => `${r.label}, ${r.fate}`).join("; ") || "no messages yet"}`}>
      <defs>
        <marker id="rl-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="rl-headpath" />
        </marker>
      </defs>
      {([["client", "Checkout"], ["net", "Network"], ["service", "Payments"]] as const).map(([k, t]) => (
        <g key={k}>
          <text x={LANE[k]} y={12} textAnchor="middle" className="rl-lane">{t}</text>
          <line x1={LANE[k]} y1={18} x2={LANE[k]} y2={h} className={"rl-life" + (k === "net" ? " net" : "")} />
        </g>
      ))}
      {rows.map((r, i) => <Arrow key={r.n} r={r} i={i} />)}
    </svg>
  );
}

function Controls({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const p = currentPayment(st);
  if (st.phase === "request")
    return (
      <div className="rl-ctl">
        <p>Request #{p?.attempts} is on the wire. What does the network do with it?</p>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "deliver" })}>Deliver</PgButton>
          <PgButton onClick={() => dispatch({ type: "drop" })}>Drop it</PgButton>
          <PgButton onClick={() => dispatch({ type: "crash" })}>Deliver, then crash the service</PgButton>
        </div>
      </div>
    );
  if (st.phase === "response")
    return (
      <div className="rl-ctl">
        <p>The service has done its work. Its reply is on the wire.</p>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "deliver" })}>Deliver</PgButton>
          <PgButton onClick={() => dispatch({ type: "drop" })}>Drop it</PgButton>
        </div>
      </div>
    );
  if (st.phase === "waiting" && p) {
    const giveUp = st.policy === "once" || p.attempts >= MAX_ATTEMPTS;
    return (
      <div className="rl-ctl wait">
        <p>The checkout heard nothing. From where it stands, a lost request and a lost reply look exactly the same.</p>
        <PgButton primary onClick={() => dispatch({ type: "timer" })}>
          {giveUp ? "Timer fires: give up, show an error" : `Timer fires: send attempt ${p.attempts + 1}`}
        </PgButton>
      </div>
    );
  }
  const last = st.payments[st.payments.length - 1];
  return (
    <div className="rl-ctl">
      {last && (
        <p className={chargesFor(st, last.id) === 1 && last.outcome === "paid" ? "rl-good" : "rl-bad"}>
          Payment {last.id}: the customer saw <b>{last.outcome === "paid" ? "paid" : "an error"}</b>, and the card was charged <b>{n(chargesFor(st, last.id), "time")}</b>.
        </p>
      )}
      <PgButton primary onClick={() => dispatch({ type: "pay" })}>Customer pays ${AMOUNT}</PgButton>
    </div>
  );
}

function Ledger({ st }: { st: State }) {
  return (
    <>
      <span className="label">Ledger · charges the service made</span>
      {st.ledger.length === 0 && <p className="pg-empty">No charges yet.</p>}
      <ol className="rl-ledger">
        {st.ledger.map((c) => (
          <li key={c.id} className={chargesFor(st, c.payment) > 1 ? "dup" : ""}>
            <code>charge #{c.id}</code> <span>payment {c.payment} · attempt {c.attempt} · ${AMOUNT}</span>
          </li>
        ))}
      </ol>
      {st.policy === "key" && (
        <>
          <span className="label">Idempotency table · key → first result</span>
          {Object.keys(st.keys).length === 0 && <p className="pg-empty">Empty.</p>}
          <ul className="rl-ledger">
            {Object.entries(st.keys).map(([k, v]) => <li key={k}><code>{k}</code> <span>→ charge #{v}</span></li>)}
          </ul>
        </>
      )}
    </>
  );
}

function BatchTable({ st }: { st: State }) {
  const b = st.batch;
  if (!b) return <p className="pg-empty">Pick a drop rate and run it. Each policy gets the same network luck.</p>;
  const rows: { label: string; get: (x: BatchStats) => number; bad?: boolean }[] = [
    { label: "Charged exactly once", get: (x) => x.exactlyOnce },
    { label: "Never charged", get: (x) => x.unpaid, bad: true },
    { label: "Charged twice or more", get: (x) => x.doubled, bad: true },
    { label: "Charged, but told it failed", get: (x) => x.chargedButError, bad: true },
    { label: "Messages sent", get: (x) => x.messages },
  ];
  return (
    <div className="rl-table" role="table" aria-label="Batch results by policy">
      <div role="row" className="rl-tr head">
        <span role="columnheader" />
        {b.stats.map((x) => <span role="columnheader" key={x.policy}>{POLICY_LABEL[x.policy]}</span>)}
      </div>
      {rows.map((r) => (
        <div role="row" className="rl-tr" key={r.label}>
          <span role="rowheader">{r.label}</span>
          {b.stats.map((x) => <span role="cell" key={x.policy} className={r.bad && r.get(x) > 0 ? "bad" : ""}>{r.get(x)}</span>)}
        </div>
      ))}
    </div>
  );
}

function Result({ st }: { st: State }) {
  const t = tally(st);
  const b = st.batch;
  if (!t.payments && !b) return null;
  const [once, retry, key] = b ? b.stats : [];
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your network did</span>
      {t.payments > 0 && (
        <p>
          You finished {n(t.payments, "payment")} and the ledger holds {n(t.charges, "charge")} (${t.charges * AMOUNT} for ${t.payments * AMOUNT} of orders).
          {t.doubled ? ` ${n(t.doubled, "customer was", "customers were")} charged more than once.` : ""}
          {t.chargedButError ? ` ${n(t.chargedButError, "customer was", "customers were")} charged and told it failed.` : ""}
          {t.unpaid ? ` ${n(t.unpaid, "payment")} never went through.` : ""}
        </p>
      )}
      {b && (
        <p>
          On a link that drops {Math.round(b.drop * 100)}% of messages: no retries left {once.unpaid + once.chargedButError} of {b.runs} customers unpaid or misinformed;
          plain retries charged {n(retry.doubled, "customer")} twice (${retry.extraCharges * AMOUNT} too much); the key charged {key.exactlyOnce} of {b.runs} exactly once,
          for {key.messages - once.messages} more messages than never retrying.
        </p>
      )}
      <p className="pg-takeaway">
        The sender can never learn whether a lost message was the request or the reply, so no network can promise exactly-once delivery. You get an exactly-once effect by retrying until acknowledged and letting the server recognise repeats by key, with the key saved in the same transaction as the charge.
      </p>
    </div>
  );
}

export default function ReliableLinksPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const busy = st.phase === "request" || st.phase === "response" || st.phase === "waiting";
  const b = st.batch;
  const answer = b && b.stats[2].exactlyOnce < b.runs ? "none" : "key";

  return (
    <PgFrame title="A checkout, a lossy network and a payment service" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The network drops one message in five. You run 100 checkouts under each policy. Which policy charges every customer exactly once?"
        options={[{ value: "once", label: "Never retry" }, { value: "retry", label: "Retry until answered" }, { value: "key", label: "Retry with an idempotency key" }, { value: "none", label: "None of them" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={!!b}
        answer={answer}
        explain={answer === "key"
          ? "Retry with a key. Never retrying loses payments whenever a message drops. Retrying fixes that but charges twice whenever the reply was the message that dropped. The key lets the service spot the repeat and send back the first answer."
          : `At this drop rate even the key loses some: after ${BATCH_ATTEMPTS} attempts the client gives up. It never charges twice, but a customer can be charged and told it failed. Keys stop duplicates; they cannot beat a link that stays down.`}
      />

      <div className="rl-policy">
        <span className="label">Checkout policy</span>
        <PgChoice<Policy> label="Checkout policy" value={st.policy}
          options={POLICIES.map((p) => ({ value: p, label: POLICY_LABEL[p], note: POLICY_NAME[p] }))}
          disabledOptions={busy ? POLICIES.filter((p) => p !== st.policy) : []}
          onChange={(p) => dispatch({ type: "setPolicy", policy: p })} />
        <span className="rl-mode">Delivery: {POLICY_NAME[st.policy]}</span>
        {st.policy === "key" && (
          <label className="rl-check">
            <input type="checkbox" checked={st.atomic} onChange={(e) => dispatch({ type: "setAtomic", atomic: e.target.checked })} />
            Save the key in the same transaction as the charge
          </label>
        )}
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Messages · you are the network</span>
          {st.rows.length === 0 ? <p className="pg-empty">Press Customer pays to send the first request.</p> : <Sequence st={st} />}
          <Controls st={st} dispatch={dispatch} />
        </div>
        <div className="pg-card">
          <Ledger st={st} />
          <dl className="pg-stats">
            {(() => {
              const t = tally(st);
              return (
                <>
                  <div><dt>Payments</dt><dd>{t.payments}</dd></div>
                  <div><dt>Charges</dt><dd>{t.charges}</dd></div>
                  <div className={t.doubled ? "bad" : ""}><dt>Charged twice</dt><dd>{t.doubled}</dd></div>
                  <div className={t.chargedButError ? "bad" : ""}><dt>Charged, told failed</dt><dd>{t.chargedButError}</dd></div>
                </>
              );
            })()}
          </dl>
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="rl-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <div className="pg-card">
        <span className="label">At scale · 100 checkouts per policy, up to {BATCH_ATTEMPTS} attempts each</span>
        <div className="rl-batch">
          <label className="rl-slider">
            Drop rate <b>{Math.round(st.dropRate * 100)}%</b>
            <input type="range" min={0} max={40} step={5} value={Math.round(st.dropRate * 100)}
              onChange={(e) => dispatch({ type: "setDrop", rate: Number(e.target.value) / 100 })} aria-label="Share of messages the network drops" />
          </label>
          <PgButton primary onClick={() => dispatch({ type: "batch" })}>Run 100 checkouts</PgButton>
        </div>
        <div className={reduced ? "" : "rl-fade"} key={b ? `${b.drop}` : "none"}><BatchTable st={st} /></div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Stripe's idempotent requests", href: "https://docs.stripe.com/api/idempotent_requests" },
        { title: "Brandur Leach's Stripe-like idempotency keys in Postgres", href: "https://brandur.org/idempotency-keys" },
        { title: "Two Generals' Problem", href: "https://en.wikipedia.org/wiki/Two_Generals%27_Problem" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.rl-policy { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.rl-mode { font-family: var(--f-code); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
.rl-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; flex-basis: 100%; }
.rl-seq { width: 100%; height: auto; display: block; background: var(--surface); border: 1px solid var(--line); }
.rl-lane { font-family: var(--f-code); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; fill: var(--ink-2); }
.rl-life { stroke: var(--line); stroke-width: 1; }
.rl-life.net { stroke-dasharray: 3 3; }
.rl-msg line { stroke: var(--accent); stroke-width: 1.6; }
.rl-msg.flying line { stroke-dasharray: 4 3; }
.rl-msg.bad line { stroke: var(--pain); }
.rl-headpath { fill: var(--accent); }
.rl-label { font-family: var(--f-code); font-size: 9.5px; fill: var(--ink); }
.rl-note { font-family: var(--f-code); font-size: 9px; fill: var(--ink-2); }
.rl-msg.bad .rl-note { fill: var(--pain); }
.rl-x { font-family: var(--f-code); font-size: 11px; fill: var(--pain); font-weight: 700; }
.rl-packet { fill: var(--accent); animation: rl-pulse 1s ease-in-out infinite alternate; }
@keyframes rl-pulse { from { opacity: .45; } to { opacity: 1; } }
.rl-ctl { display: grid; gap: 6px; justify-items: start; border-top: 1px solid var(--line); padding-top: 8px; }
.rl-ctl p { margin: 0; font-size: .95rem; }
.rl-ctl.wait p { color: var(--pain); }
.rl-good { color: var(--good); }
.rl-bad { color: var(--pain); }
.rl-ledger { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 180px; overflow: auto; }
.rl-ledger li { border: 1px solid var(--line); background: var(--surface); padding: 3px 8px; font-size: .85rem; display: flex; gap: 8px; flex-wrap: wrap; }
.rl-ledger li.dup { border-color: var(--pain); background: var(--pain-bg); }
.rl-ledger code { font-size: .7rem; background: none; padding: 0; }
.rl-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.rl-ch li.done { color: var(--good); }
.rl-batch { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.rl-slider { display: flex; gap: 8px; align-items: center; font-size: .92rem; }
.rl-table { display: grid; border: 1px solid var(--line); background: var(--line); gap: 1px; font-size: .85rem; }
.rl-tr { display: grid; grid-template-columns: minmax(0, 1.4fr) repeat(3, minmax(0, 1fr)); gap: 1px; }
.rl-tr > span { background: var(--surface); padding: 4px 6px; font-variant-numeric: tabular-nums; }
.rl-tr.head > span { font-family: var(--f-code); font-size: .6rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
.rl-tr > span.bad { color: var(--pain); font-weight: 700; }
.rl-fade { animation: pg-hop .3s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .rl-packet, .rl-fade { animation: none; } }
`;
