"use client";
import { useEffect, useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  ANSWER, DEADLINES, END, ERROR_AT, GOALS, SCENARIOS, ctxStatus, init, step, workStatus,
  type Action, type CtxNode, type Guess, type Node, type NodeId, type Scenario, type State, type WorkNode, type WorkStatus,
} from "./model";

const CSS = `
.context-cancellation-tree { display: grid; gap: 3px; }
.context-cancellation-row { display: grid; grid-template-columns: minmax(0, 15em) minmax(0, 1fr); gap: 8px; align-items: center; }
@media (max-width: 560px) { .context-cancellation-row { grid-template-columns: 1fr; gap: 2px; } }
.context-cancellation-lab { display: grid; gap: 1px; padding-left: calc(var(--depth) * 14px); border-left: 2px solid transparent; position: relative; min-width: 0; }
.context-cancellation-lab::before { content: ""; position: absolute; left: calc(var(--depth) * 14px - 10px); top: .7em; width: 7px; border-top: 1px solid var(--line); display: var(--elbow); }
.context-cancellation-lab code { font-family: var(--f-code); font-size: .72rem; overflow-wrap: anywhere; }
.context-cancellation-lab small { color: var(--ink-2); font-size: .74rem; line-height: 1.25; }
.context-cancellation-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.context-cancellation-chip { font-family: var(--f-code); font-size: .56rem; letter-spacing: .06em; text-transform: uppercase; padding: 1px 5px; border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap; }
.context-cancellation-chip.closed, .context-cancellation-chip.burning, .context-cancellation-chip.failed { color: var(--pain); border-color: var(--pain); font-weight: 700; }
.context-cancellation-chip.stopped, .context-cancellation-chip.done { color: var(--good); border-color: var(--good); }
.context-cancellation-chip.running, .context-cancellation-chip.detached { color: var(--accent); border-color: var(--accent); }
.context-cancellation-lab .pg-btn { padding: 0 6px; font-size: .72rem; justify-self: start; }
.context-cancellation-track { position: relative; height: 1.5em; background: var(--bg); border: 1px solid var(--line); overflow: hidden; }
.context-cancellation-track.ctx { height: .9em; }
.context-cancellation-seg { position: absolute; top: 0; bottom: 0; }
.context-cancellation-seg.open { background: var(--hl); }
.context-cancellation-seg.closed { background: repeating-linear-gradient(45deg, var(--pain-bg) 0 4px, transparent 4px 8px); }
.context-cancellation-seg.run { background: var(--accent); opacity: .55; }
.context-cancellation-seg.burn { background: var(--pain); }
.context-cancellation-seg.detach { background: var(--good); opacity: .6; }
.context-cancellation-cur { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink); }
.context-cancellation-resp { position: absolute; top: 0; bottom: 0; border-left: 2px dashed var(--good); }
.context-cancellation-axis { display: flex; justify-content: space-between; font-family: var(--f-code); font-size: .58rem; color: var(--ink-2); }
.context-cancellation-time { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.context-cancellation-time input { width: 100%; accent-color: var(--accent); }
.context-cancellation-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.context-cancellation-goals li { font-size: .9rem; padding-left: 1.6em; position: relative; }
.context-cancellation-goals li::before { content: "○"; position: absolute; left: 0; font-family: var(--f-code); color: var(--ink-2); }
.context-cancellation-goals li.met::before { content: "✓"; color: var(--good); font-weight: 700; }
`;

const pct = (ms: number) => `${(Math.min(END, Math.max(0, ms)) / END) * 100}%`;

const DEPTH: Record<NodeId, number> = { req: 0, handler: 1, group: 2, inventory: 3, pricing: 3, fraud: 3, recs: 2, audit: 2 };

const WS_LABEL: Record<WorkStatus, string> = {
  waiting: "not started", running: "running", done: "done", failed: "error", stopped: "stopped by ctx",
  burning: "burning: nobody wants this", detached: "running on purpose",
};

function CtxRow({ n, t }: { n: CtxNode; t: number }) {
  const s = ctxStatus(n, t);
  const at = n.doneAt ?? END;
  return (
    <div className="context-cancellation-row">
      <div className="context-cancellation-lab" style={{ ["--depth" as string]: DEPTH[n.id], ["--elbow" as string]: DEPTH[n.id] ? "block" : "none" }}>
        <div className="context-cancellation-head">
          <code>{n.code}</code>
          <span className={`context-cancellation-chip ${s}`}>Done {s}</span>
        </div>
        {s === "closed" && <small>{n.cause} at {n.doneAt} ms</small>}
      </div>
      <div className="context-cancellation-track ctx" aria-label={`${n.code}: Done ${n.doneAt === null ? "never closes" : `closes at ${n.doneAt} ms`}`}>
        <span className="context-cancellation-seg open" style={{ left: 0, width: pct(at) }} />
        {n.doneAt !== null && <span className="context-cancellation-seg closed" style={{ left: pct(at), right: 0 }} />}
        <span className="context-cancellation-cur" style={{ left: pct(t) }} />
      </div>
    </div>
  );
}

function WorkRow({ n, st, dispatch }: { n: WorkNode; st: State; dispatch: (a: Action) => void }) {
  const t = st.time;
  const s = workStatus(n, t);
  const depth = n.parent === null ? 0 : DEPTH[n.id];
  const goodEnd = n.uselessAt === null ? n.end : Math.min(n.end, Math.max(n.start, n.uselessAt));
  const fix = n.id === "fraud"
    ? <PgButton onClick={() => dispatch({ type: "fixFraud", on: !st.config.fraudChecks })}>{st.config.fraudChecks ? "undo fix" : "fix: check gctx.Err()"}</PgButton>
    : n.id === "recs"
      ? <PgButton onClick={() => dispatch({ type: "fixRecs", on: !st.config.recsUsesCtx })}>{st.config.recsUsesCtx ? "undo fix" : "fix: pass ctx"}</PgButton>
      : null;
  return (
    <div className="context-cancellation-row">
      <div className="context-cancellation-lab" style={{ ["--depth" as string]: depth, ["--elbow" as string]: depth ? "block" : "none" }}>
        <div className="context-cancellation-head">
          <code>go {n.code}</code>
          <span className={`context-cancellation-chip ${s}`}>{WS_LABEL[s]}</span>
        </div>
        <small>{n.job}{n.wasted ? ` · ${n.wasted} ms wasted` : ""}</small>
        {fix}
      </div>
      <div className="context-cancellation-track" aria-label={`${n.code}: runs ${n.start} to ${n.end} ms, ${n.reason}${n.wasted ? `, ${n.wasted} ms after nobody needed it` : ""}`}>
        {n.detached
          ? <span className="context-cancellation-seg detach" style={{ left: pct(n.start), width: `calc(${pct(n.end)} - ${pct(n.start)})` }} />
          : <>
            <span className="context-cancellation-seg run" style={{ left: pct(n.start), width: `calc(${pct(goodEnd)} - ${pct(n.start)})` }} />
            {n.wasted > 0 && <span className="context-cancellation-seg burn" style={{ left: pct(goodEnd), width: `calc(${pct(n.end)} - ${pct(goodEnd)})` }} />}
          </>}
        <span className="context-cancellation-resp" style={{ left: pct(st.outcome.respondAt) }} />
        <span className="context-cancellation-cur" style={{ left: pct(t) }} />
      </div>
    </div>
  );
}

function Tree({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  const byId = Object.fromEntries(st.outcome.nodes.map((n) => [n.id, n])) as Record<NodeId, Node>;
  const order: NodeId[] = ["req", "handler", "group", "inventory", "pricing", "fraud", "audit", "recs"];
  const detachedRecs = !st.config.recsUsesCtx;
  return (
    <div className="context-cancellation-tree" role="list" aria-label="The request's context tree over time">
      {order.filter((id) => !(detachedRecs && id === "recs")).map((id) => {
        const n = byId[id];
        return <div key={id} role="listitem">{n.kind === "ctx" ? <CtxRow n={n} t={st.time} /> : <WorkRow n={n} st={st} dispatch={dispatch} />}</div>;
      })}
      {detachedRecs && (
        <div role="listitem" style={{ marginTop: 6 }}>
          <span className="label">A second tree: context.Background()</span>
          <WorkRow n={byId.recs as WorkNode} st={st} dispatch={dispatch} />
        </div>
      )}
      <div className="context-cancellation-row" aria-hidden="true">
        <span />
        <div className="context-cancellation-axis"><span>0 ms</span><span>{END / 2}</span><span>{END} ms</span></div>
      </div>
    </div>
  );
}

const GUESSES: { value: Guess; label: string }[] = [
  { value: "60", label: "At 60 ms, when pricing fails" },
  { value: "180", label: "At 180 ms, when inventory would be done" },
  { value: "250", label: "At 250 ms, when fraud scoring is done" },
];

function Result({ st }: { st: State }) {
  if (!st.played) return null;
  const o = st.outcome, b = st.baseline;
  const changed = st.config.fraudChecks || st.config.recsUsesCtx;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your result</span>
      <p><b>Starting handler</b>, same scenario: answered at {b.respondAt} ms ({b.statusText}), with {b.wasted} ms of work done for nobody.</p>
      {changed && <p><b>Your handler</b>: answered at {o.respondAt} ms ({o.statusText}), with {o.wasted} ms of work done for nobody.</p>}
      <p className="pg-takeaway">
        {changed && o.wasted <= 5
          ? "Cancelling a context only closes a channel. Your fixes made every goroutine look at that channel, so the cancel turned into stopped work and an early answer."
          : "Cancel closed the Done channels all the way down the tree, at once. It stopped nothing by itself: only the goroutines that look at ctx stopped. fraud.Score ignored it, and because errgroup.Wait waits for every goroutine, the response waited for it too. recs was never in the tree."}
      </p>
    </div>
  );
}

export default function ContextCancellation() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [playing, setPlaying] = useState(false);
  const o = st.outcome;

  useEffect(() => {
    if (!playing) return;
    if (st.time >= END) { setPlaying(false); return; }
    const id = setTimeout(() => dispatch({ type: "time", t: st.time + 10 }), 28);
    return () => clearTimeout(id);
  }, [playing, st.time, dispatch]);

  const run = () => {
    if (reduced) { dispatch({ type: "run" }); return; }
    dispatch({ type: "time", t: 0 });
    setPlaying(true);
  };

  return (
    <PgFrame title="Cancel a request tree" onReset={() => { setPlaying(false); dispatch({ type: "reset" }); }}>
      <style>{CSS}</style>
      <p className="pg-rule">
        A checkout handler runs inventory, pricing and fraud checks in an errgroup, fetches optional recommendations,
        and writes an audit record when it returns. Each row is a context or a goroutine, drawn over time.
        <b> Pick what goes wrong, run the request, and drag time to watch the cancel travel down the tree.</b>
      </p>

      <PgPredict<Guess>
        question={`pricing.Quote fails at ${ERROR_AT} ms, so errgroup cancels the group's context. When does the handler send its error response?`}
        options={GUESSES}
        value={st.guess}
        onChange={(g) => dispatch({ type: "guess", guess: g })}
        revealed={st.played}
        answer={ANSWER}
        explain="Cancelling closed gctx.Done() at 60 ms and inventory stopped at once. fraud.Score is a CPU loop that never looks at ctx, so it ran to 250 ms. g.Wait() returns only when every goroutine in the group has returned, so the 500 went out at 250 ms."
      />

      <div className="pg-actions" style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="label">What goes wrong</span>
          <PgChoice<Scenario> label="Scenario" value={st.config.scenario} options={SCENARIOS.map((s) => ({ value: s.value, label: s.label, note: s.note }))}
            onChange={(v) => dispatch({ type: "scenario", scenario: v })} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="label">Deadline</span>
          <PgChoice<string> label="Handler deadline" value={String(st.config.deadline)} options={DEADLINES.map((d) => ({ value: String(d), label: `${d} ms` }))}
            onChange={(v) => dispatch({ type: "deadline", deadline: Number(v) })} />
        </div>
      </div>

      <div className="pg-card">
        <div className="context-cancellation-time">
          <PgButton primary onClick={run}>{st.played ? "Replay" : "Run request"}</PgButton>
          <input type="range" min={0} max={END} step={5} value={st.time} aria-label="Time in milliseconds"
            onChange={(e) => { setPlaying(false); dispatch({ type: "time", t: Number(e.target.value) }); }} />
          <span style={{ fontFamily: "var(--f-code)", fontVariantNumeric: "tabular-nums" }}>t = {st.time} ms</span>
        </div>
        <Tree st={st} dispatch={dispatch} />
        <p className="pg-note">Solid line: now. Dashed green line: the response goes out. Red: work still running after nobody needs it.</p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">This request</span>
          <dl className="pg-stats">
            <div><dt>Response at</dt><dd>{st.played ? `${o.respondAt} ms` : "?"}</dd></div>
            <div><dt>Status</dt><dd>{st.played ? o.status : "?"}</dd></div>
            <div className={st.played && o.wasted ? "bad" : ""}><dt>Wasted work</dt><dd>{st.played ? `${o.wasted} ms` : "?"}</dd></div>
            <div className={st.played && o.runningAtResponse.length ? "bad" : ""}><dt>Running after response</dt><dd>{st.played ? (o.runningAtResponse.join(", ") || "audit only") : "?"}</dd></div>
          </dl>
        </div>
        <div className="pg-card">
          <span className="label">Challenges</span>
          <ul className="context-cancellation-goals">
            {GOALS.map((g) => <li key={g.id} className={st.played && g.met(o, st.config) ? "met" : ""}>{g.text}</li>)}
          </ul>
          <p className="pg-note">The fixes are on the fraud and recs rows. Then try the other scenarios and a 150 ms deadline.</p>
        </div>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "the Go blog, Go Concurrency Patterns: Context", href: "https://go.dev/blog/context" },
        { title: "Anton Zhiyanov's runnable Gist of Go: Context", href: "https://antonz.org/go-concurrency/context/" },
        { title: "context.go, the cancelCtx tree", href: "https://github.com/golang/go/blob/master/src/context/context.go" },
      ]} />
    </PgFrame>
  );
}
