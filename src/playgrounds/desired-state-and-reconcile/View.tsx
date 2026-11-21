"use client";
import { useEffect, useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, EVICT_AFTER, MAX_REPLICAS, NODES, NOT_READY_AFTER, SIDES, SIDE_INFO,
  active, connected, init, podStatus, ready, step,
  type Side, type State,
} from "./model";

const HOW: Record<Lang, string> = {
  go: "Go: controller-runtime gives you this loop. Reconcile(ctx, req) receives only a name; you read the object and its pods from the informer cache, and an error or RequeueAfter puts the name back on the rate-limited work queue.",
  python: "Python: kopf turns handlers into an operator, and its timers and daemons give you periodic passes. With the official client you write the list, watch and re-list yourself, and every event should only mean: look again.",
  typescript: "TypeScript: @kubernetes/client-node has makeInformer, which lists, watches and keeps a cache. Restart it on its error event, and have every add, update or delete event schedule one reconcile of the owner.",
  rust: "Rust: kube-rs's Controller runs reconcile(obj, ctx) for you, de-duplicates wake-ups per object, and re-runs it on the Action you return: Action::requeue(d) or the error_policy's backoff.",
};

const SPEEDS = [
  { value: "1", label: "10×" },
  { value: "5", label: "50×" },
];

type Guess = "both" | "loop" | "neither";

function Lane({ st, side, onDelete, onNode }: { st: State; side: Side; onDelete: (name: string) => void; onNode: (i: number) => void }) {
  const l = st.lanes[side];
  const r = ready(st, l);
  const a = active(l).length;
  const ok = r === st.replicas && a === st.replicas;
  return (
    <section className={"pg-card rec-lane" + (ok ? "" : " off")} aria-label={SIDE_INFO[side].name}>
      <header className="rec-lane-head">
        <div>
          <h4>{SIDE_INFO[side].name}</h4>
          <span className="muted rec-how">{SIDE_INFO[side].how}</span>
        </div>
        <span className={"rec-count" + (ok ? " good" : " bad")} aria-live="polite">
          {r}/{st.replicas} ready{a !== r ? ` · ${a} counted` : ""}
        </span>
      </header>
      <div className="rec-nodes">
        {NODES.map((n, i) => {
          const node = st.nodes[i];
          const gone = node.deadAt === null ? 0 : st.t - node.deadAt;
          const label = node.alive ? "Ready" : gone >= NOT_READY_AFTER ? `NotReady · ${gone} s` : `silent · ${gone} s`;
          const pods = l.pods.filter((p) => p.node === i);
          return (
            <div key={n} className={"rec-node" + (node.alive ? "" : " dead")}>
              <button className="rec-node-btn" onClick={() => onNode(i)} title={node.alive ? `Kill ${n}` : `Bring ${n} back`}>
                <b>{n}</b><span>{label}</span>
              </button>
              <div className="rec-pods">
                {pods.map((p) => {
                  const status = podStatus(st, p);
                  return (
                    <button key={p.name} className={"rec-pod " + status.toLowerCase()} onClick={() => onDelete(p.name)}
                      disabled={p.phase === "Terminating"} aria-label={`${p.name}, ${status}. Delete it.`} title={`Delete ${p.name}`}>
                      <span>{p.name.replace("worker-", "w")}</span><small>{status === "ContainerCreating" ? "starting" : status}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {l.pods.some((p) => p.node === null) && (
        <p className="rec-unsched">Unscheduled: {l.pods.filter((p) => p.node === null).map((p) => p.name).join(", ")} (no live node)</p>
      )}
      <dl className="pg-stats rec-stats">
        <div className={l.short ? "bad" : ""}><dt>Pod-s short</dt><dd>{l.short}</dd></div>
        <div className={l.extra ? "bad" : ""}><dt>Pod-s extra</dt><dd>{l.extra}</dd></div>
        <div><dt>API writes</dt><dd>{l.writes}</dd></div>
        {side === "script" && <div className={l.missed ? "bad" : ""}><dt>Events missed</dt><dd>{l.missed}</dd></div>}
      </dl>
      <ul className="rec-log" aria-live="polite">
        {l.log.slice(0, 4).map((e) => <li key={e.n} className={e.tone}><span>{e.t} s</span> {e.text}</li>)}
        {l.log.length === 0 && <li className="info">Nothing to do: observed equals desired.</li>}
      </ul>
    </section>
  );
}

function Result({ st }: { st: State }) {
  const sc = st.lanes.script, lp = st.lanes.loop;
  if (st.t < 15 || (!st.lastOutage && st.nodeDeadAt === null && !st.readerDeleted)) return null;
  const end = (s: Side) => `${active(st.lanes[s]).length} pods for ${st.replicas} wanted`;
  const f = st.found;
  let takeaway = "When every event arrives, reacting to events and reconciling levels look the same. The difference appears only when something is lost, and in a cluster something always is: a watch drops, a controller restarts, a node dies without saying so.";
  if (f.stopped || f.watch || f.overshoot)
    takeaway = "The script acted on what it was told; the loop acted on what it saw. Events are only wake-ups. The loop re-lists after any gap and compares the whole desired state with the whole observed state, so a lost event costs one pass, not a permanent error.";
  else if (f.node)
    takeaway = "A dead node sends no events, so nothing happens until the node lifecycle controller decides the node is gone and evicts its pods. Then the loop counts fewer pods and fills the gap. The evicted pods never report DELETED, so a handler waiting for that event waits until the node returns.";
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">Your cluster, in your numbers</span>
      <p>
        After {st.t} s, the event script runs {end("script")}, and was {sc.short} pod-seconds short{sc.extra ? ` and ${sc.extra} pod-seconds over` : ""}, having missed {sc.missed} events.
        {" "}The reconcile loop runs {end("loop")}, and was {lp.short} pod-seconds short{lp.extra ? ` and ${lp.extra} over` : ""}.
        {lp.recoveredAfter !== null ? ` After the node died, the loop was whole again in ${lp.recoveredAfter} s${sc.recoveredAfter !== null ? `, the script in ${sc.recoveredAfter} s` : "; the script, not while the node stayed down"}.` : ""}
      </p>
      <p className="pg-takeaway">{takeaway}</p>
    </div>
  );
}

export default function ReconcilePlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  useEffect(() => { setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  useEffect(() => {
    if (!playing) return;
    const h = window.setInterval(() => dispatch({ type: "tick", seconds: Number(speed) }), 100);
    return () => window.clearInterval(h);
  }, [playing, speed, dispatch]);

  const toolbar = (
    <>
      <PgButton onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</PgButton>
      <PgButton onClick={() => dispatch({ type: "tick", seconds: 10 })} disabled={playing}>+10 s</PgButton>
      <PgChoice label="Speed" value={speed} options={SPEEDS} onChange={setSpeed} />
    </>
  );
  const f = st.found;

  return (
    <PgFrame title="Two controllers, one cluster's worth of trouble" toolbar={toolbar}
      onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Stop the controllers. Delete two pods and raise replicas to 4. Start the controllers again. Which side ends up running 4 pods?"
        options={[
          { value: "both", label: "Both: they see the new spec" },
          { value: "loop", label: "Only the reconcile loop" },
          { value: "neither", label: "Neither, until another pod dies" },
        ]}
        value={guess} onChange={setGuess} revealed={f.stopped} answer="loop"
        explain={<>The script restarted, read replicas = {st.replicas} as its new baseline and waited for events. The deletions happened while it was down, so it will never hear of them: it runs {active(st.lanes.script).length}. The loop re-listed, counted {active(st.lanes.loop).length === st.replicas ? "the gap" : "what was there"} and created the difference.</>}
      />

      <div className="rec-controls">
        <div className="pg-card rec-spec">
          <span className="label">Desired state · you write this</span>
          <pre aria-hidden="true">{`kind: WorkerPool
spec:
  replicas: ${st.replicas}`}</pre>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "replicas", value: st.replicas - 1 })} disabled={st.replicas <= 0}>− replica</PgButton>
            <PgButton primary onClick={() => dispatch({ type: "replicas", value: st.replicas + 1 })} disabled={st.replicas >= MAX_REPLICAS}>+ replica</PgButton>
          </div>
        </div>
        <div className="pg-card rec-break">
          <span className="label">Break it · both sides get the same hit</span>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "controllers", on: !st.running })}>{st.running ? "Stop the controllers" : "Start the controllers"}</PgButton>
            <PgButton onClick={() => dispatch({ type: "watch", on: !st.watch })}>{st.watch ? "Drop the watch" : "Reconnect the watch"}</PgButton>
          </div>
          <p className="rec-note">Click a pod to delete it, a node name to kill or restore the node. A silent node turns NotReady after {NOT_READY_AFTER} s and its pods are evicted {EVICT_AFTER} s later.</p>
          <p className={"rec-conn" + (connected(st) ? "" : " bad")}>t = {st.t} s · {connected(st) ? "controllers watching" : !st.running ? "controllers stopped: events are lost" : "watch down: events are lost"}</p>
        </div>
      </div>

      <div className="rec-lanes">
        {SIDES.map((side) => (
          <Lane key={side} st={st} side={side}
            onDelete={(name) => dispatch({ type: "deletePod", side, name })}
            onNode={(i) => dispatch({ type: "node", index: i })} />
        ))}
      </div>

      <Result st={st} />

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="rec-goals">
          {CHALLENGES.map((c) => <li key={c.id} className={f[c.id] ? "done" : ""}>{f[c.id] ? "✓" : "○"} {c.text}</li>)}
        </ul>
      </div>

      <p className="rec-lang"><span className="label">In your language</span> {HOW[lang]}</p>

      <PgSources links={[
        { title: "Tim Hockin's talk Edge vs. Level triggered logic", href: "https://speakerdeck.com/thockin/edge-vs-level-triggered-logic" },
        { title: "James Bowes on level triggering and reconciliation", href: "https://hackernoon.com/level-triggering-and-reconciliation-in-kubernetes-1f17fe30333d" },
        { title: "the Kubernetes docs on controllers", href: "https://kubernetes.io/docs/concepts/architecture/controller/" },
      ]} />

      <style>{`
        .rec-controls { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 8px; }
        .rec-spec pre { margin: 0; font-family: var(--f-code); font-size: .8rem; background: var(--surface); border: 1px solid var(--line); padding: 6px 8px; }
        .rec-note { margin: 0; font-size: .82rem; color: var(--ink-2); }
        .rec-conn { margin: 0; font-family: var(--f-code); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--good); }
        .rec-conn.bad { color: var(--pain); }
        .rec-lanes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .rec-lane { display: grid; gap: 8px; align-content: start; }
        .rec-lane.off { border-color: var(--pain); }
        .rec-lane-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
        .rec-lane-head h4 { margin: 0; }
        .rec-how { font-size: .8rem; }
        .rec-count { font-family: var(--f-code); font-size: .8rem; font-variant-numeric: tabular-nums; white-space: nowrap; padding: 1px 6px; border: 1px solid currentColor; }
        .rec-count.good { color: var(--good); }
        .rec-count.bad { color: var(--pain); }
        .rec-nodes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
        .rec-node { border: 1px solid var(--line); background: repeating-linear-gradient(0deg, var(--surface) 0 15px, var(--grid) 15px 16px); min-height: 120px; display: grid; grid-template-rows: auto 1fr; }
        .rec-node.dead { border-style: dashed; border-color: var(--pain); background: var(--pain-bg); }
        .rec-node-btn { all: unset; cursor: pointer; display: grid; padding: 3px 5px; border-bottom: 1px solid var(--line); font-family: var(--f-code); font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; }
        .rec-node-btn:focus-visible { outline: 2px solid var(--accent); }
        .rec-node-btn span { color: var(--ink-2); }
        .rec-node.dead .rec-node-btn span { color: var(--pain); }
        .rec-pods { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px; align-content: start; }
        .rec-pod { display: grid; min-width: 44px; padding: 2px 4px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); font-family: var(--f-code); font-size: .66rem; cursor: pointer; text-align: left; transition: background .25s var(--ease), border-color .25s var(--ease); }
        .rec-pod small { font-size: .52rem; text-transform: uppercase; opacity: .85; }
        .rec-pod.containercreating, .rec-pod.pending { background: var(--surface); color: var(--ink); border-style: dashed; }
        .rec-pod.unknown { background: var(--hl); color: var(--ink); border-color: var(--pain); }
        .rec-pod.terminating { background: var(--surface-2); color: var(--ink-2); border-color: var(--line); text-decoration: line-through; cursor: default; }
        .rec-unsched { margin: 0; font-size: .8rem; color: var(--pain); }
        .rec-stats { grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); }
        .rec-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: .8rem; min-height: 5.5em; }
        .rec-log li { border-left: 3px solid var(--line); padding: 1px 6px; }
        .rec-log li.ok { border-color: var(--good); }
        .rec-log li.bad { border-color: var(--pain); }
        .rec-log li span { font-family: var(--f-code); font-size: .64rem; color: var(--ink-2); }
        .rec-goals { list-style: none; padding-left: 0 !important; }
        .rec-goals li.done { color: var(--good); }
        .rec-lang { margin: 0; font-size: .92rem; }
        @media (max-width: 760px) { .rec-controls, .rec-lanes { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .rec-pod { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
