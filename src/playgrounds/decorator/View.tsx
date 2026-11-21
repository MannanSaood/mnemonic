"use client";
import type { ReactNode } from "react";
import { PgButton, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  GOALS, LAYERS, LAYER_JOB, LAYER_NAME, LIMIT, START, TRAFFIC, allGoalsMet, changed, init, stackCount, step,
  type Action, type Cell, type Guess, type LayerId, type Metrics, type Outcome, type State,
} from "./model";

const CSS = `
.decorator-onion { display: grid; gap: 0; }
.decorator-layer { border: 1px solid var(--line); background: var(--surface); padding: 4px 6px 6px; display: grid; gap: 4px; }
.decorator-layer header { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.decorator-name { font-family: var(--f-code); font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.decorator-job { margin: 0; font-size: .82rem; color: var(--ink-2); line-height: 1.3; }
.decorator-btns { display: flex; gap: 2px; }
.decorator-btns .pg-btn { padding: 1px 7px; font-size: .78rem; }
.decorator-core { border: 1px dashed var(--ink-2); background: var(--bg); padding: 6px; font-family: var(--f-code); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; text-align: center; }
.decorator-tray { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.decorator-grid { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); overflow-x: auto; }
.decorator-row { display: grid; grid-template-columns: minmax(7.5em, 1.6fr) repeat(var(--cols), minmax(2.6em, 1fr)) 3.2em; gap: 1px; }
.decorator-row > * { background: var(--surface); padding: 3px 4px; font-family: var(--f-code); font-size: .64rem; display: flex; align-items: center; justify-content: center; text-align: center; min-width: 0; }
.decorator-row > .who { justify-content: flex-start; text-align: left; font-family: var(--f-text); font-size: .8rem; }
.decorator-row.head > * { background: var(--bg); color: var(--ink-2); letter-spacing: .06em; text-transform: uppercase; font-size: .58rem; }
.decorator-row.leak > * { background: var(--pain-bg); }
.decorator-row.changed > .who { box-shadow: inset 3px 0 0 var(--accent); }
.decorator-c-skip { color: var(--line); }
.decorator-c-stop, .decorator-c-leak { color: var(--pain) !important; font-weight: 700; }
.decorator-c-hit { color: var(--good); font-weight: 700; }
.decorator-c-logged { color: var(--accent); font-weight: 700; }
.decorator-c-run { color: var(--ink); font-weight: 700; }
.decorator-why { grid-column: 1 / -1; justify-content: flex-start !important; text-align: left !important; font-family: var(--f-text) !important; font-size: .8rem !important; color: var(--ink-2); padding-left: 8px !important; }
.decorator-row.leak .decorator-why { color: var(--pain); }
.decorator-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 0; }
.decorator-stats div { background: var(--surface); padding: 6px 8px; display: grid; gap: 2px; }
.decorator-stats dt { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.decorator-stats dd { margin: 0; font-family: var(--f-code); font-size: .85rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.decorator-stats div.bad dd { color: var(--pain); }
.decorator-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.decorator-goals li { font-size: .92rem; padding-left: 1.6em; position: relative; }
.decorator-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.decorator-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
.decorator-fresh { animation: pg-hop .35s var(--ease) both; }
@media (prefers-reduced-motion: reduce) { .decorator-fresh { animation: none; } }
`;

const CELL: Record<Cell, string> = { pass: "→", logged: "LOG", stop: "", hit: "HIT", miss: "MISS", run: "DB", skip: "·" };

function cellText(o: Outcome, c: Cell): { text: string; cls: string } {
  if (c === "stop") return { text: String(o.status), cls: "stop" };
  if ((c === "hit" || c === "run") && o.leak) return { text: CELL[c], cls: "leak" };
  return { text: CELL[c], cls: c };
}

/* ---------------- the stack, drawn as nested wrappers ---------------- */

function Onion({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const build = (i: number): ReactNode => {
    if (i === st.stack.length) return <div className="decorator-core">handleOrders · the database</div>;
    const l = st.stack[i];
    return (
      <div className={"decorator-layer " + l}>
        <header>
          <span className="decorator-name">{LAYER_NAME[l]}</span>
          <span className="decorator-btns">
            <PgButton onClick={() => dispatch({ type: "move", layer: l, dir: -1 })} disabled={i === 0} title={`Move ${LAYER_NAME[l]} out one layer`}>↑ out</PgButton>
            <PgButton onClick={() => dispatch({ type: "move", layer: l, dir: 1 })} disabled={i === st.stack.length - 1} title={`Move ${LAYER_NAME[l]} in one layer`}>↓ in</PgButton>
            <PgButton onClick={() => dispatch({ type: "remove", layer: l })} title={`Remove ${LAYER_NAME[l]}`}>×</PgButton>
          </span>
        </header>
        <p className="decorator-job">{LAYER_JOB[l]}</p>
        {build(i + 1)}
      </div>
    );
  };
  const missing = LAYERS.filter((l) => !st.stack.includes(l));
  return (
    <div className="decorator-onion">
      <span className="label">The stack: a request enters at the top and works inward</span>
      {build(0)}
      {missing.length > 0 && (
        <div className="decorator-tray" style={{ marginTop: 8 }}>
          <span className="muted">Not in the stack:</span>
          {missing.map((l) => <PgButton key={l} onClick={() => dispatch({ type: "add", layer: l })}>+ {LAYER_NAME[l]} (outermost)</PgButton>)}
        </div>
      )}
    </div>
  );
}

/* ---------------- the traffic, one row per request ---------------- */

function Traffic({ st, reduced }: { st: State; reduced: boolean }) {
  const r = st.run!;
  const diff = changed(st.prev, r);
  const cols = r.stack.length + 1;
  return (
    <div className="decorator-grid" role="table" aria-label="What each request met, layer by layer" style={{ ["--cols" as string]: cols }}>
      <div className="decorator-row head" role="row">
        <span className="who" role="columnheader">Request</span>
        {r.stack.map((l) => <span key={l} role="columnheader">{LAYER_NAME[l]}</span>)}
        <span role="columnheader">Handler</span>
        <span role="columnheader">Got</span>
      </div>
      {r.outcomes.map((o) => {
        const isNew = diff.includes(o.req.id);
        return (
          <div key={o.req.id} role="row" className={"decorator-row" + (o.leak ? " leak" : "") + (isNew ? " changed" : "")}>
            <span className="who" role="cell">#{o.req.id} {o.req.label}</span>
            {o.cells.map((c, j) => {
              const t = cellText(o, c);
              return <span key={j} role="cell" className={`decorator-c-${t.cls}` + (isNew && !reduced ? " decorator-fresh" : "")} style={isNew && !reduced ? { animationDelay: `${j * 70}ms` } : undefined}>{t.text}</span>;
            })}
            <span role="cell" className={o.leak ? "decorator-c-leak" : o.status === 200 ? "" : "decorator-c-stop"}>{o.status}</span>
            <span role="cell" className="decorator-why">{o.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function Stats({ m }: { m: Metrics }) {
  return (
    <dl className="decorator-stats">
      <div className={m.leaks ? "bad" : ""}><dt>Leaks</dt><dd>{m.leaks}</dd></div>
      <div className={m.logged < m.total ? "bad" : ""}><dt>Logged</dt><dd>{m.logged} of {m.total}</dd></div>
      <div><dt>429s</dt><dd>{m.throttled}</dd></div>
      <div><dt>Token checks</dt><dd>{m.authChecks}</dd></div>
      <div><dt>DB calls</dt><dd>{m.dbCalls}</dd></div>
    </dl>
  );
}

const order = (s: LayerId[]) => s.length ? s.map((l) => LAYER_NAME[l]).join(" → ") : "no wrappers";
const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Result({ st }: { st: State }) {
  const b = st.baseline!.metrics, m = st.run!.metrics;
  const diff = changed(st.prev, st.run);
  if (allGoalsMet(m)) {
    return (
      <div className="pg-result" aria-live="polite">
        <span className="label">Your result</span>
        <p><b>Starting order</b> ({order(START)}): {n(b.leaks, "leak")}, {b.logged} of {b.total} requests logged, {n(b.throttled, "429")}, {n(b.authChecks, "token check")}.</p>
        <p><b>Your order</b> ({order(st.run!.stack)}): {n(m.leaks, "leak")}, {m.logged} of {m.total} logged, {n(m.throttled, "429")}, {n(m.authChecks, "token check")}. It took you {n(st.changes, "change")} to the stack.</p>
        <p className="pg-takeaway">You never edited a wrapper or the handler. Every fix was a change of order, because each wrapper only sees what the wrappers outside it let through. That is the power of Decorator, and its main risk: the order is part of the design, so write it down in one place.</p>
      </div>
    );
  }
  if (!st.prev) return null;
  return (
    <p className="muted" aria-live="polite">
      {diff.length
        ? `That change altered ${n(diff.length, "response")} (${diff.map((d) => "#" + d).join(", ")}, marked at the left).`
        : "That change altered no response. Look at the log column and the counters instead."}
    </p>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "401", label: "401 Unauthorized" },
  { value: "leak", label: "Ana's orders" },
  { value: "429", label: "429 Too Many Requests" },
];

export default function DecoratorMiddleware() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  return (
    <PgFrame title="Stack the middleware, replay the traffic" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <p className="pg-rule">
        Four wrappers guard an orders API. Each one has the same shape as the handler, so they nest in any order. The
        same {TRAFFIC.length} requests replay every time you change the stack. <b>Your job: meet all four goals below by
        changing only the order.</b>
      </p>

      <PgPredict<Guess>
        question={`Ana loads /orders/42, then a request with no token asks for /orders/42. With the stack ${order(START)} → handler, what does that request get?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={!!st.run}
        answer="leak"
        explain="Cache sits outside Auth, so it answers before anyone has checked a token. It has no user to key on, only the path, and Ana's response is stored under that path. Auth is fine, Cache is fine, the order is wrong."
      />

      <div className="pg-grid">
        <div className="pg-card">
          <Onion st={st} dispatch={dispatch} />
          <ul className="decorator-goals" aria-label="Goals">
            {GOALS.map((g) => <li key={g.id} className={st.run && g.met(st.run.metrics) ? "met" : ""}>{g.text}</li>)}
          </ul>
          <p className="pg-note">RateLimit allows {LIMIT} requests per client. {LAYERS.length} wrappers can be stacked {stackCount(LAYERS.length)} different ways. With subclasses instead of wrappers, each of those would be its own class.</p>
        </div>
        <div className="pg-card">
          {st.run ? (
            <>
              <span className="label">Traffic through {order(st.run.stack)} → handler</span>
              <Traffic st={st} reduced={reduced} />
              <Stats m={st.run.metrics} />
              <Result st={st} />
            </>
          ) : (
            <>
              <span className="label">Traffic</span>
              <p className="pg-empty">Nothing sent yet. Make your prediction, then send the traffic. After that, every change to the stack replays it.</p>
              <PgButton primary onClick={() => dispatch({ type: "send" })}>Send {TRAFFIC.length} requests</PgButton>
            </>
          )}
        </div>
      </div>

      <PgSources links={[
        { title: "Alex Edwards, Making and using HTTP middleware", href: "https://www.alexedwards.net/blog/making-and-using-middleware" },
        { title: "Refactoring.Guru's Decorator", href: "https://refactoring.guru/design-patterns/decorator" },
        { title: "the onion model in Battle-Tested Patterns", href: "https://patterns.totorojam.com/patterns/middleware-chain/" },
      ]} />
    </PgFrame>
  );
}
