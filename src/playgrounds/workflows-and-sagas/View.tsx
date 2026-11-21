"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  AMOUNT, CHALLENGES, FAIL_REASON, LANES, PREDICT_ANSWER, STEP_SVC, SVC_LABEL,
  challengeDone, halfDone, init, leftovers, predictRevealed, step, summarize, timeline, worldAt,
  type Action, type Config, type FailAt, type Msg, type State, type Style, type Svc, type World,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const STYLE_LABEL: Record<Style, string> = { orch: "Orchestration", chor: "Choreography" };
const STEP_NAME: Record<1 | 2 | 3, string> = { 1: "reserve stock", 2: "charge the card", 3: "book a courier" };

/* ---------------- the message sequence ---------------- */

const ROW = 26;
function Sequence({ msgs, cursor, style, reduced }: { msgs: Msg[]; cursor: number; style: Style; reduced: boolean }) {
  const lanes = LANES[style];
  const W = 560, L = 10;
  const gap = (W - 2 * L) / lanes.length;
  const x = (s: Svc) => L + gap * (lanes.indexOf(s) + 0.5);
  const shown = msgs.slice(0, cursor);
  const H = 30 + Math.max(msgs.length, 6) * ROW + 6;
  return (
    <svg className="sg-seq" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Messages so far: ${shown.map((m) => `${SVC_LABEL[m.from]} to ${SVC_LABEL[m.to]}: ${m.label}`).join("; ") || "none"}`}>
      <defs>
        <marker id="sg-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="sg-headpath" />
        </marker>
      </defs>
      {lanes.map((s) => (
        <g key={s}>
          <text className="sg-lane" x={x(s)} y={14} textAnchor="middle">{SVC_LABEL[s]}</text>
          <line className={"sg-life" + (s === "orch" ? " orch" : "")} x1={x(s)} x2={x(s)} y1={20} y2={H} />
        </g>
      ))}
      {shown.map((m, i) => {
        const y = 36 + i * ROW;
        const cls = "sg-msg " + m.kind + (i === cursor - 1 && !reduced ? " fresh" : "");
        if (m.from === m.to) {
          return (
            <g key={i} className={cls}>
              <rect x={x(m.from) - 4} y={y - 9} width={250} height={16} className="sg-self" />
              <text x={x(m.from) + 2} y={y + 3} className="sg-label">{m.kind === "crash" ? "✗ " : ""}{m.label}</text>
            </g>
          );
        }
        const x1 = x(m.from), x2 = x(m.to);
        const mid = (x1 + x2) / 2;
        return (
          <g key={i} className={cls}>
            <line x1={x1} x2={x2 + (x2 > x1 ? -3 : 3)} y1={y} y2={y} markerEnd={m.kind === "ignored" ? undefined : "url(#sg-head)"} />
            {m.kind === "ignored" && <text x={x2 + (x2 > x1 ? -8 : 8)} y={y + 4} textAnchor="middle" className="sg-x">✗</text>}
            <text x={mid} y={y - 5} textAnchor="middle" className="sg-label">{m.label}</text>
          </g>
        );
      })}
      {cursor === 0 && <text className="sg-lane" x={W / 2} y={70} textAnchor="middle">press Next message to start the saga</text>}
    </svg>
  );
}

/* ---------------- each service's state ---------------- */

function svcState(s: Svc, w: World): { text: string; bad: boolean } {
  const dead = w.order === "rejected";
  switch (s) {
    case "orders": return { text: w.order === "none" ? "no order" : `order 1042: ${w.order}`, bad: false };
    case "inventory": return { text: w.reserved ? "1 unit reserved" : "nothing reserved", bad: dead && w.reserved > 0 };
    case "payments": {
      const net = w.charged - w.refunded;
      return { text: w.charged ? (w.refunded ? `$${AMOUNT / 100} charged, refunded` : `$${AMOUNT / 100} charged`) : "nothing charged", bad: dead && net > 0 };
    }
    case "shipping": return { text: w.courier === "none" ? "no courier" : `courier ${w.courier}`, bad: dead && w.courier === "booked" };
    case "email": return { text: w.email === "none" ? "nothing sent" : w.email === "confirmed" ? "confirmation sent" : "cancellation sent", bad: false };
    case "orch": return { text: "", bad: false };
  }
}

function Services({ st, w, dispatch }: { st: State; w: World; dispatch: (a: Action) => void }) {
  const svcs: Svc[] = ["orders", "inventory", "payments", "shipping", "email"];
  return (
    <div className="sg-svcs">
      {svcs.map((s) => {
        const stepNo = (Object.entries(STEP_SVC).find(([, v]) => v === s)?.[0] ?? null) as "1" | "2" | "3" | null;
        const failing = stepNo !== null && st.config.failAt === Number(stepNo);
        const state = svcState(s, w);
        const body = (
          <>
            <span className="sg-name">{SVC_LABEL[s]}</span>
            <span className={"sg-state" + (state.bad ? " bad" : "")}>{state.text}</span>
            {stepNo && <span className={"sg-fail" + (failing ? " on" : "")}>{failing ? `fails: ${FAIL_REASON[Number(stepNo) as 1 | 2 | 3]}` : "click to make it fail"}</span>}
          </>
        );
        return stepNo ? (
          <button key={s} className={"sg-svc" + (failing ? " failing" : "") + (state.bad ? " bad" : "")} aria-pressed={failing}
            onClick={() => dispatch({ type: "fail", at: (failing ? 0 : Number(stepNo)) as FailAt })}>{body}</button>
        ) : (
          <div key={s} className="sg-svc">{body}</div>
        );
      })}
    </div>
  );
}

function SagaLog({ st, msgs }: { st: State; msgs: Msg[] }) {
  const c = st.config;
  const shown = msgs.slice(0, st.cursor);
  if (c.style === "chor") {
    return (
      <div className="pg-card">
        <span className="label">Where is order 1042?</span>
        <p className="sg-small">No single place knows. Each service holds its own piece; to answer a support ticket you query all of them and rebuild the story from their events.</p>
      </div>
    );
  }
  const crashedAt = shown.findIndex((m) => m.kind === "crash");
  const lost = crashedAt >= 0 && !c.durable;
  const entries = shown.filter((m, i) => m.from === "orch" && (m.kind === "cmd" || m.kind === "comp") && (!lost || i < crashedAt));
  return (
    <div className="pg-card">
      <span className="label">Saga log · {c.durable ? "durable, in the orchestrator's database" : "in memory only"}</span>
      {lost ? (
        <p className="sg-small bad">The orchestrator crashed and its log was only in memory. After the restart nobody knows order 1042 is half done.</p>
      ) : entries.length ? (
        <ol className="sg-log">{entries.map((m, i) => <li key={i} className={m.kind === "comp" ? "comp" : ""}>{m.label}</li>)}</ol>
      ) : (
        <p className="pg-empty">Empty.</p>
      )}
    </div>
  );
}

function Compare({ c }: { c: Config }) {
  const rows = (["orch", "chor"] as Style[]).map((style) => ({ style, s: summarize({ ...c, style, crash: style === "orch" && c.crash, deaf: style === "chor" && c.deaf }) }));
  return (
    <table className="sg-table">
      <caption className="label">This failure, both ways{c.failAt ? ` · ${STEP_NAME[c.failAt]} fails` : " · nothing fails"}</caption>
      <thead><tr><th /><th scope="col">Orchestration</th><th scope="col">Choreography</th></tr></thead>
      <tbody>
        <tr><th scope="row">Messages</th>{rows.map((r) => <td key={r.style}>{r.s.messages}</td>)}</tr>
        <tr><th scope="row">Compensations</th>{rows.map((r) => <td key={r.style}>{r.s.compensations}</td>)}</tr>
        <tr><th scope="row">Steps half-done</th>{rows.map((r) => <td key={r.style}>{r.s.halfDoneSteps}</td>)}</tr>
        <tr><th scope="row">State lives in</th>{rows.map((r) => <td key={r.style}>{r.s.stateIn}</td>)}</tr>
        <tr><th scope="row">Left behind</th>{rows.map((r) => <td key={r.style} className={r.s.leftovers.length ? "bad" : ""}>{r.s.leftovers.join(", ") || "nothing"}</td>)}</tr>
      </tbody>
    </table>
  );
}

function Result({ st }: { st: State }) {
  const last = st.finished[st.finished.length - 1];
  if (!last) return null;
  const c = last.config;
  const s = summarize(c);
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your last run did</span>
      <p>
        {STYLE_LABEL[c.style]}, {c.failAt ? `${STEP_NAME[c.failAt]} failed` : "nothing failed"}, compensations {c.compensate ? "on" : "off"}
        {c.style === "orch" && c.crash ? `, the orchestrator crashed with ${c.durable ? "a durable" : "an in-memory"} log` : ""}
        {c.style === "chor" && c.deaf ? ", Inventory deaf to failures" : ""}:
        {" "}{n(s.messages, "message")}, {n(s.compensations, "compensation")}, and for {n(s.halfDoneSteps, "message")} anyone reading the services saw a pending order with real effects behind it.
        {" "}{s.leftovers.length ? `It ended with ${s.leftovers.join(", ")}, and nothing will clean it up.` : "It ended clean."}
        {st.finished.length > 1 ? ` Across your ${st.finished.length} runs, ${st.finished.filter((f) => f.leftovers.length).length} left something behind.` : ""}
      </p>
      <p className="pg-takeaway">
        There is no rollback across services. Every step that succeeded before the failure needs its own compensating action, run in reverse, and until the last one runs the half-done order is visible to everyone. Someone must know which steps to undo: a durable orchestrator, or every service listening for the right failure event.
      </p>
    </div>
  );
}

export default function SagaPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const c = st.config;
  const msgs = timeline(c);
  const w = worldAt(msgs, st.cursor);
  const done = st.cursor >= msgs.length;
  const end = leftovers(w);

  return (
    <PgFrame title="An order saga across four services" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <div className="pg-req">
        <span className="label">The setup</span>
        <p>An order needs stock reserved, a card charged and a courier booked, in three services with three databases. There is no transaction across them. Click a service to make its step fail, then step through the messages and watch what each service holds.</p>
      </div>

      <PgPredict
        question="The courier step fails, after stock was reserved and the card charged. With compensations on, how many compensating actions run?"
        options={[{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]}
        value={st.predict}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={predictRevealed(st)}
        answer={PREDICT_ANSWER}
        explain={<>Three: refund the card, release the stock, and reject the pending order, in reverse order. The courier step failed, so it has nothing to undo. A failure at the last step undoes the most.</>}
      />

      <div className="sg-controls">
        <div><span className="label">Coordination</span>
          <PgChoice<Style> label="Coordination" value={c.style}
            options={[{ value: "orch", label: "Orchestration" }, { value: "chor", label: "Choreography" }]}
            onChange={(s) => dispatch({ type: "style", style: s })} />
        </div>
        <label className="sg-check"><input type="checkbox" checked={c.compensate} onChange={(e) => dispatch({ type: "compensate", on: e.target.checked })} /> Compensating actions</label>
        {c.style === "orch" ? (
          <>
            <label className="sg-check"><input type="checkbox" checked={c.crash} onChange={(e) => dispatch({ type: "crash", on: e.target.checked })} /> Orchestrator crashes after the failure</label>
            <label className="sg-check"><input type="checkbox" checked={c.durable} onChange={(e) => dispatch({ type: "durable", on: e.target.checked })} /> Durable saga log</label>
          </>
        ) : (
          <label className="sg-check"><input type="checkbox" checked={c.deaf} onChange={(e) => dispatch({ type: "deaf", on: e.target.checked })} /> Inventory never subscribed to failure events</label>
        )}
      </div>

      <Services st={st} w={w} dispatch={dispatch} />

      <div className="pg-actions">
        <PgButton primary disabled={done} onClick={() => dispatch({ type: "next" })}>Next message ({st.cursor}/{msgs.length})</PgButton>
        <PgButton disabled={done} onClick={() => dispatch({ type: "run" })}>Run to the end</PgButton>
        <PgButton disabled={st.cursor === 0} onClick={() => dispatch({ type: "rewind" })}>Rewind</PgButton>
      </div>

      <Sequence msgs={msgs} cursor={st.cursor} style={c.style} reduced={reduced} />

      <p className={"sg-status" + (done && end.length ? " bad" : halfDone(w) ? " warn" : done ? " good" : "")} aria-live="polite">
        {st.cursor === 0
          ? "Nothing has happened yet."
          : done
            ? end.length ? `Finished, and left behind: ${end.join(", ")}.` : w.order === "approved" ? "Finished: the order is approved and every step took effect." : "Finished: the order is rejected and every step was undone."
            : halfDone(w)
              ? "Half-done: the order is still pending but real effects exist. A report run now would count them."
              : "In progress."}
      </p>

      <div className="pg-grid">
        <SagaLog st={st} msgs={msgs} />
        <Compare c={c} />
      </div>

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="sg-ch">
          {CHALLENGES.map((ch) => (
            <li key={ch.id} className={challengeDone(st, ch.id) ? "done" : ""}>{challengeDone(st, ch.id) ? "✓ " : ""}{ch.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Chris Richardson's Saga pattern", href: "https://microservices.io/patterns/data/saga.html" },
        { title: "Temporal's saga explainer", href: "https://temporal.io/blog/saga-pattern-made-easy" },
        { title: "Garcia-Molina and Salem's 1987 Sagas paper", href: "https://dl.acm.org/doi/10.1145/38713.38742" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.sg-controls { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: end; }
.sg-controls > div { display: grid; gap: 4px; }
.sg-check { display: flex; gap: 6px; align-items: center; font-size: .9rem; }
.sg-svcs { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 6px; }
.sg-svc { display: grid; gap: 2px; align-content: start; text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; color: var(--ink); min-height: 64px; transition: border-color .2s var(--ease), background .2s var(--ease); }
button.sg-svc { cursor: pointer; }
.sg-svc.failing { border-color: var(--pain); border-style: dashed; border-width: 2px; }
.sg-svc.bad { background: var(--pain-bg); border-color: var(--pain); }
.sg-name { font-family: var(--f-code); font-size: .66rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.sg-state { font-size: .86rem; font-weight: 600; }
.sg-state.bad { color: var(--pain); }
.sg-fail { font-size: .72rem; color: var(--ink-2); }
.sg-fail.on { color: var(--pain); font-weight: 600; }
.sg-seq { width: 100%; height: auto; display: block; border: 1px solid var(--line); background: var(--bg); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 20px 20px; }
.sg-lane { font-family: var(--f-code); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; fill: var(--ink-2); }
.sg-life { stroke: var(--line); stroke-width: 1; }
.sg-life.orch { stroke: var(--accent); stroke-dasharray: 4 3; }
.sg-msg line { stroke: var(--ink-2); stroke-width: 1.4; }
.sg-msg.cmd line, .sg-msg.event line { stroke: var(--accent); }
.sg-msg.reply line { stroke-dasharray: 3 3; }
.sg-msg.fail line, .sg-msg.ignored line { stroke: var(--pain); stroke-width: 1.8; }
.sg-msg.comp line { stroke: var(--good); stroke-width: 2; }
.sg-msg.ignored line { stroke-dasharray: 2 3; }
.sg-headpath { fill: var(--ink-2); }
.sg-label { font-family: var(--f-code); font-size: 9px; fill: var(--ink); }
.sg-msg.fail .sg-label, .sg-msg.ignored .sg-label, .sg-msg.crash .sg-label { fill: var(--pain); font-weight: 700; }
.sg-msg.comp .sg-label { fill: var(--good); font-weight: 700; }
.sg-self { fill: var(--surface); stroke: var(--line); }
.sg-msg.crash .sg-self { fill: var(--pain-bg); stroke: var(--pain); }
.sg-x { font-family: var(--f-code); font-size: 11px; fill: var(--pain); font-weight: 700; }
.sg-msg.fresh { animation: pg-hop .3s var(--ease) both; }
.sg-status { margin: 0; font-size: .95rem; }
.sg-status.bad { color: var(--pain); font-weight: 600; }
.sg-status.warn { color: var(--pain); }
.sg-status.good { color: var(--good); }
.sg-small { margin: 0; font-size: .9rem; }
.sg-small.bad { color: var(--pain); }
.sg-log { margin: 0; padding-left: 1.4em; display: grid; gap: 2px; font-family: var(--f-code); font-size: .78rem; }
.sg-log li.comp { color: var(--good); }
.sg-table { border-collapse: collapse; width: 100%; font-size: .84rem; }
.sg-table caption { text-align: left; padding-bottom: 6px; }
.sg-table th, .sg-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
.sg-table th { font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; background: var(--surface-2); }
.sg-table td.bad { color: var(--pain); font-weight: 600; }
.sg-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.sg-ch li.done { color: var(--good); }
@media (prefers-reduced-motion: reduce) { .sg-svc { transition: none; } .sg-msg.fresh { animation: none; } }
`;
