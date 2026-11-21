"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, JOB, LABEL, SAVE_MS, SUBS, TIMEOUT_MS, challengeDone, init, panelLabel, step, subscribed, waitingLive, zombies,
  type Design, type Hop, type Mode, type State, type Trace,
} from "./model";

const MODES: { value: Mode; label: string; note: string }[] = [
  { value: "ok", label: "OK", note: "Handles the event normally" },
  { value: "slow", label: "Slow", note: "Takes 2.5 s (a mail server or API that hangs)" },
  { value: "throws", label: "Throws", note: "Raises an exception (a bug, or a provider that is down)" },
];

const HOP_TEXT: Record<Hop["result"], string> = {
  ok: "✓", slow: "slow", threw: "threw ✗", skipped: "never called", zombie: "closed tab, still called",
  queued: "queued", behind: "behind", retrying: "will retry", piling: "piling up, nobody reads",
};
const BAD: Hop["result"][] = ["threw", "skipped", "zombie", "piling"];
const WARN: Hop["result"][] = ["slow", "behind", "retrying"];

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Customer({ t, design }: { t: Trace; design: Design }) {
  if (t.customer === "error")
    return <p className="observer-say bad">Order #{t.order} was saved, then a listener threw. The exception came back up through PlaceOrder and the customer saw an error page. They will probably try again and pay twice.</p>;
  if (t.customer === "timeout")
    return <p className="observer-say bad">Order #{t.order}: the customer waited {t.ms} ms. The gateway gave up at {TIMEOUT_MS} ms and showed an error, though the order went through.</p>;
  return <p className="observer-say">Order #{t.order} confirmed in {t.ms} ms.{design === "queue" ? " The request only saved the order and wrote the event." : ""}</p>;
}

/** The customer's wait, segment by segment, against the gateway timeout (the dark tick). */
function Bar({ t, design, reduced }: { t: Trace; design: Design; reduced: boolean }) {
  const scale = Math.max(3000, t.ms);
  const segs: { key: string; label: string; ms: number; slow?: boolean }[] = design === "queue"
    ? [{ key: "save", label: "save + outbox", ms: t.ms }]
    : [{ key: "save", label: "save", ms: SAVE_MS }, ...t.hops.filter((h) => h.ms > 0).map((h) => ({ key: h.key, label: h.label, ms: h.ms, slow: h.result === "slow" }))];
  return (
    <div>
      <span className="label">Customer waits {t.ms} ms · timeout {TIMEOUT_MS} ms</span>
      <div className="observer-bar" role="img" aria-label={`Checkout took ${t.ms} ms; the timeout is ${TIMEOUT_MS} ms`}>
        {segs.map((h) => (
          <i key={h.key} className={h.slow ? "slow" : ""} style={{ width: `${(h.ms / scale) * 100}%`, transition: reduced ? "none" : undefined }} title={`${h.label} ${h.ms} ms`} />
        ))}
        <b style={{ left: `${(TIMEOUT_MS / scale) * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}

function Lane({ st, design, reduced }: { st: State; design: Design; reduced: boolean }) {
  const t = design === "inproc" ? st.inproc.last : st.queue.last;
  const it = st.inproc.tally, qt = st.queue.tally;
  return (
    <section className="pg-side" aria-label={design === "inproc" ? "In-process loop" : "Behind a queue"}>
      <header><h4>{design === "inproc" ? "In-process loop" : "Behind a queue"}</h4></header>
      <p className="muted">
        {design === "inproc"
          ? "PlaceOrder calls each listener in turn, inside the customer's request."
          : "PlaceOrder writes the event to an outbox and returns. Each listener reads it at its own pace."}
      </p>
      {t ? (
        <>
          <div className={"pg-entry" + (t.customer === "ok" ? " ok" : " fail") + (reduced ? "" : " fresh")} key={t.order}>
            <div className="pg-path observer-hops">
              <span>order #{t.order} saved</span>
              {t.hops.map((h, j) => (
                <span key={h.key} className={BAD.includes(h.result) ? "bad" : WARN.includes(h.result) ? "warn" : ""} style={{ animationDelay: `${(j + 1) * 110}ms` }}>
                  {h.label} {HOP_TEXT[h.result]}{h.ms > 0 && h.result !== "ok" ? ` ${h.ms} ms` : ""}
                </span>
              ))}
              {t.hops.length === 0 && <span>no listeners</span>}
            </div>
            <Customer t={t} design={design} />
          </div>
          <Bar t={t} design={design} reduced={reduced} />
        </>
      ) : (
        <p className="pg-empty">Place an order to see who gets called, in what order, and what the customer waits for.</p>
      )}
      {design === "inproc" ? (
        <dl className="pg-stats">
          <div className={it.errors ? "bad" : ""}><dt>Customer errors</dt><dd>{it.errors}</dd></div>
          <div className={it.slowest > TIMEOUT_MS ? "bad" : ""}><dt>Slowest checkout</dt><dd>{it.slowest} ms</dd></div>
          <div className={it.lost ? "bad" : ""}><dt>Lost deliveries</dt><dd>{it.lost}</dd></div>
          <div className={it.zombieCalls ? "bad" : ""}><dt>Calls to closed tabs</dt><dd>{it.zombieCalls}</dd></div>
        </dl>
      ) : (
        <dl className="pg-stats">
          <div><dt>Customer errors</dt><dd>0</dd></div>
          <div><dt>Slowest checkout</dt><dd>{qt.slowest} ms</dd></div>
          <div className={waitingLive(st) ? "bad" : ""}><dt>Waiting, not lost</dt><dd>{waitingLive(st)}</dd></div>
          <div className={qt.abandoned ? "bad" : ""}><dt>Piled in dead queues</dt><dd>{qt.abandoned}</dd></div>
        </dl>
      )}
    </section>
  );
}

function Result({ st }: { st: State }) {
  if (!st.orders) return null;
  const it = st.inproc.tally, qt = st.queue.tally;
  const hurt = it.errors + it.lost + it.zombieCalls > 0 || it.slowest > TIMEOUT_MS;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your {n(st.orders, "order")} showed</span>
      <p><b>In-process:</b> {n(it.errors, "customer")} saw an error, the slowest checkout took {it.slowest} ms, {n(it.lost, "delivery", "deliveries")} never happened, and closed tabs were called {n(it.zombieCalls, "time")}.</p>
      <p><b>Behind a queue:</b> no customer saw an error and every checkout took {qt.slowest} ms. {n(waitingLive(st), "message")} {waitingLive(st) === 1 ? "is" : "are"} waiting for a broken or slow listener{qt.caughtUp ? `, and ${n(qt.caughtUp, "message")} arrived late after a fix` : ""}.{qt.abandoned ? ` ${n(qt.abandoned, "message")} piled up in queues nobody reads.` : ""}</p>
      <p className="pg-takeaway">
        {hurt
          ? "The order service never names its listeners, yet it paid for every one of them. In-process, each listener's time and each exception becomes the customer's, and a listener nobody unsubscribed is called forever. A queue moves that cost off the request, and you pay with reactions that arrive later."
          : "So far every listener behaved, and both designs look the same. Break one (Slow or Throws) and place another order."}
      </p>
    </div>
  );
}

export default function ObserverPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const missing = SUBS.filter((s) => !subscribed(st, s));
  const openPanels = st.panels.filter((p) => p.open);

  return (
    <PgFrame title="Order placed: who pays for the subscribers?" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="The mail provider is down, so the email listener throws. A customer places an order through the in-process loop. What happens?"
        options={[
          { value: "fine", label: "The order goes through; only the email is missing" },
          { value: "error", label: "The customer sees an error, and later listeners never run" },
          { value: "unsaved", label: "The order is not saved" },
        ]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={st.sawThrow}
        answer="error"
        explain="The order was saved first. Then the loop called Email, the exception travelled up through PlaceOrder, and Inventory and Analytics were never called. The customer saw an error for an order that exists. The listeners are hidden from the order service's code, yet they run on its call stack."
      />

      <div className="pg-card">
        <span className="label">Subject · OrderService · its listeners, in call order</span>
        <ol className="observer-subs">
          {st.subs.map((x, i) => (
            <li key={x.key} className={x.panel !== undefined && !st.panels.find((p) => p.n === x.panel)?.open ? "zombie" : ""}>
              <span className="observer-idx">{i + 1}</span>
              {x.sub ? (
                <>
                  <span><b>{LABEL[x.sub]}</b> <span className="muted">{JOB[x.sub]}</span></span>
                  <PgChoice label={`${LABEL[x.sub]} behaviour`} value={st.modes[x.sub]} options={MODES} onChange={(m) => dispatch({ type: "setMode", sub: x.sub!, mode: m })} />
                  <PgButton onClick={() => dispatch({ type: "toggleSub", sub: x.sub! })}>Unsubscribe</PgButton>
                </>
              ) : (
                <span className="observer-wide"><b>{panelLabel(x.panel!)}</b> <span className="muted">{st.panels.find((p) => p.n === x.panel)?.open ? "live-orders panel" : "tab is closed, listener is still here"}</span></span>
              )}
            </li>
          ))}
          {st.subs.length === 0 && <li className="muted">No listeners. The order service still works; nobody hears about orders.</li>}
        </ol>
        {missing.length > 0 && (
          <div className="pg-actions">
            {missing.map((s) => <PgButton key={s} onClick={() => dispatch({ type: "toggleSub", sub: s })}>+ Subscribe {LABEL[s]}</PgButton>)}
          </div>
        )}
        <div className="observer-tabs">
          <span className="label">Admin tabs</span>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "openPanel" })}>Open admin tab</PgButton>
            {openPanels.map((p) => <PgButton key={p.n} onClick={() => dispatch({ type: "closePanel", n: p.n })}>Close tab {p.n}</PgButton>)}
          </div>
          <label className="observer-check">
            <input type="checkbox" checked={st.unsubscribeOnClose} onChange={(e) => dispatch({ type: "setUnsubscribeOnClose", on: e.target.checked })} />
            Closing a tab unsubscribes its panel
          </label>
          {zombies(st) > 0 && <p className="observer-say bad">{n(zombies(st), "closed tab")} still subscribed. The subject holds them, so they are never freed and run on every order.</p>}
        </div>
      </div>

      <div className="pg-actions">
        <PgButton primary onClick={() => dispatch({ type: "place" })}>Place order</PgButton>
        <PgButton onClick={() => dispatch({ type: "place", count: 5 })}>Place 5 orders</PgButton>
      </div>

      <div className="pg-sides">
        <Lane st={st} design="inproc" reduced={reduced} />
        <Lane st={st} design="queue" reduced={reduced} />
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="observer-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Refactoring.Guru's Observer", href: "https://refactoring.guru/design-patterns/observer" },
        { title: "RxMarbles", href: "https://rxmarbles.com/" },
        { title: "the lapsed listener problem", href: "https://en.wikipedia.org/wiki/Lapsed_listener_problem" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.observer-subs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.observer-subs li { display: grid; grid-template-columns: 1.6em minmax(0, 1fr) auto auto; gap: 8px; align-items: center; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; }
.observer-subs li.zombie { border-color: var(--pain); background: var(--pain-bg); }
.observer-wide { grid-column: 2 / -1; }
.observer-idx { font-family: var(--f-code); font-size: .7rem; color: var(--accent); }
.observer-tabs { border-top: 1px solid var(--line); padding-top: 8px; display: grid; gap: 6px; }
.observer-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; }
.observer-say { margin: 0; font-size: .95rem; }
.observer-say.bad { color: var(--pain); }
.observer-hops span.bad { border-color: var(--pain); color: var(--pain); }
.observer-hops span.warn { border-style: dashed; border-color: var(--pain); }
.observer-bar { position: relative; display: flex; height: 14px; border: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.observer-bar i { display: block; height: 100%; background: var(--accent); border-right: 1px solid var(--surface); transition: width .3s var(--ease); }
.observer-bar i.slow { background: var(--pain); }
.observer-bar b { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink); }
.observer-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.observer-ch li.done { color: var(--good); }
@media (max-width: 560px) {
  .observer-subs li { grid-template-columns: 1.6em minmax(0, 1fr); }
  .observer-subs li > .pg-choice, .observer-subs li > .pg-btn { grid-column: 2; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) { .observer-bar i { transition: none; } }
`;
